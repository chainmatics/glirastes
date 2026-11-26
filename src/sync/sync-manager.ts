import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';
import {
  EnvironmentControlSchema,
  type EnvironmentControl,
} from '../contracts/environment-control.js';
import {
  RuntimeSyncVerificationError,
  type RuntimeRevisionVerifier,
} from './signature-verifier.js';
import {
  type RuntimeControlState,
  type RuntimeStateStore,
  type RuntimeSyncState,
} from './state-store.js';
import { materializeDeploymentRevisions } from './materialize-deployment.js';
import type { MaterializedDeploymentRevisions } from './materialize-deployment.js';

const WireSyncBundleSchema = z.object({
  cursor: z.iso.datetime({ offset: true }),
  activeSnapshotComplete: z.literal(true),
  deployments: z.array(z.unknown()),
  revocations: z.array(z.unknown()),
  control: z.unknown().optional(),
}).strict();

/**
 * What a sync did with the environment control: `absent` (Platform without
 * control), `kept` (null after an accepted one, or none yet), `accepted`,
 * `stale` (sequence not higher), `scope_mismatch`, `unverifiable` (local halt).
 */
export type RuntimeControlOutcome =
  | 'absent'
  | 'kept'
  | 'accepted'
  | 'stale'
  | 'scope_mismatch'
  | 'unverifiable';

export type RuntimeEnvironmentControlErrorCode =
  | 'control_unverifiable'
  | 'control_scope_mismatch';

/** Content-free report of a delivered control the runner did not accept. */
export class RuntimeEnvironmentControlError extends Error {
  constructor(readonly code: RuntimeEnvironmentControlErrorCode) {
    super(code === 'control_unverifiable'
      ? 'Glirastes environment control could not be verified; the assistant is halted'
      : 'Glirastes environment control names another tenant, app or environment');
    this.name = 'RuntimeEnvironmentControlError';
  }
}

export interface RuntimeSyncApplyResult {
  state: RuntimeSyncState;
  rejectedDeploymentIds: string[];
  rejectedRevocationIds: string[];
  control: RuntimeControlOutcome;
}

export class RuntimeSyncManager {
  constructor(private readonly options: {
    environmentId: string;
    /** When set, a control of another app is rejected. */
    targetAppId?: string;
    store: RuntimeStateStore;
    verifier: RuntimeRevisionVerifier;
    validateDeployment?: (
      deployment: RuntimeDeploymentBundle,
      revisions: MaterializedDeploymentRevisions,
    ) => void | Promise<void>;
    onRevocations?: (revocations: SecurityRevocation[]) => void | Promise<void>;
    onPending?: (deployments: RuntimeDeploymentBundle[]) => void | Promise<void>;
    onActivated?: (deployments: RuntimeDeploymentBundle[]) => void | Promise<void>;
    onControlRejected?: (code: RuntimeEnvironmentControlErrorCode) => void;
  }) {}

  async apply(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
    const wire = WireSyncBundleSchema.parse(rawBundle);
    let state = await this.options.store.load() ?? this.emptyState();
    // First, so a failed key lookup aborts the sync before anything else applies.
    const controlResult = await this.applyControl(wire, state);
    if (controlResult.next) {
      state = { ...state, control: controlResult.next };
      await this.options.store.saveAtomic(state);
    }
    const rejectedRevocationIds: string[] = [];
    const acceptedRevocations: SecurityRevocation[] = [];

    for (const rawRevocation of wire.revocations) {
      const parsed = SecurityRevocationSchema.safeParse(rawRevocation);
      const id = this.objectId(rawRevocation, 'revocationId');
      if (
        !parsed.success
        || parsed.data.environmentId !== this.options.environmentId
      ) {
        rejectedRevocationIds.push(id);
        continue;
      }
      try {
        await this.options.verifier.verifyRevocation(parsed.data);
        acceptedRevocations.push(parsed.data);
      } catch {
        rejectedRevocationIds.push(parsed.data.revocationId);
      }
    }

    if (acceptedRevocations.length > 0) {
      const byId = new Map(
        state.revocations.map((revocation) => [revocation.revocationId, revocation]),
      );
      for (const revocation of acceptedRevocations) {
        byId.set(revocation.revocationId, revocation);
      }
      state = {
        ...state,
        revocations: [...byId.values()],
        updatedAt: wire.cursor,
      };
      // Persist revocations before candidate processing. A crash may replay the
      // same cursor, but revocation IDs make that replay idempotent.
      await this.options.store.saveAtomic(state);
      await this.options.onRevocations?.(acceptedRevocations);
    }

    const acceptedDeployments: RuntimeDeploymentBundle[] = [];
    const rejectedDeploymentIds: string[] = [];
    let rejectedActive = false;
    let rejectedPending = false;
    for (const rawDeployment of wire.deployments) {
      const parsed = RuntimeDeploymentBundleSchema.safeParse(rawDeployment);
      const id = this.objectId(rawDeployment, 'deploymentId');
      const rawStatus = (
        rawDeployment
        && typeof rawDeployment === 'object'
        && 'status' in rawDeployment
      ) ? (rawDeployment as { status?: unknown }).status : undefined;
      if (
        !parsed.success
        || !this.deploymentScopeMatches(parsed.data)
      ) {
        rejectedDeploymentIds.push(id);
        if (rawStatus === 'active') rejectedActive = true;
        else rejectedPending = true;
        continue;
      }
      try {
        await this.options.verifier.verifyRevision(parsed.data.agentRevision);
        await this.options.verifier.verifyRevision(parsed.data.manifestRevision);
        await this.options.verifier.verifyRevision(parsed.data.policyRevision);
        // Artifact bindings are signed material like the three revisions above;
        // accepting them unverified would smuggle unsigned desired state into
        // the fail-closed path.
        if (parsed.data.configRevision) {
          await this.options.verifier.verifyRevision(parsed.data.configRevision);
        }
        if (parsed.data.promptBinding) {
          await this.options.verifier.verifyPromptBinding(
            parsed.data.promptBinding,
          );
        }
        const materialized = materializeDeploymentRevisions(parsed.data);
        await this.options.validateDeployment?.(parsed.data, materialized);
        acceptedDeployments.push(parsed.data);
      } catch {
        rejectedDeploymentIds.push(parsed.data.deploymentId);
        if (parsed.data.status === 'active') rejectedActive = true;
        else rejectedPending = true;
      }
    }

    const active = acceptedDeployments.filter(
      (deployment) => deployment.status === 'active',
    );
    const pending = acceptedDeployments.filter(
      (deployment) => deployment.status === 'pending',
    );
    if (!rejectedActive && wire.activeSnapshotComplete) {
      state = {
        ...state,
        stable: this.latest(active, 'stable'),
        canary: this.latest(active, 'canary'),
      };
    }
    const activeIds = new Set(
      active.map((deployment) => deployment.deploymentId),
    );
    const nextPending = (
      rejectedPending
        ? this.mergePending(state.pending, pending)
        : pending
    ).filter((deployment) => !activeIds.has(deployment.deploymentId));
    state = {
      ...state,
      pending: nextPending,
      cursor: wire.cursor,
      updatedAt: wire.cursor,
    };
    await this.options.store.saveAtomic(state);
    if (pending.length > 0) await this.options.onPending?.(pending);
    if (active.length > 0 && !rejectedActive) {
      await this.options.onActivated?.(active);
    }

    return {
      state,
      rejectedDeploymentIds,
      rejectedRevocationIds,
      control: controlResult.outcome,
    };
  }

  private async applyControl(
    wire: z.infer<typeof WireSyncBundleSchema>,
    state: RuntimeSyncState,
  ): Promise<{ outcome: RuntimeControlOutcome; next?: RuntimeControlState }> {
    if (!('control' in wire)) return { outcome: 'absent' };
    if (wire.control === null) return { outcome: 'kept' };
    const current = state.control ?? { accepted: null, localHalt: null };
    const parsed = EnvironmentControlSchema.safeParse(wire.control);
    if (!parsed.success) return this.unverifiable(current);
    try {
      await this.options.verifier.verifyEnvironmentControl(parsed.data);
    } catch (error) {
      // A JWKS outage is no verdict on the control; retry with the next sync.
      if (!(error instanceof RuntimeSyncVerificationError)) throw error;
      return this.unverifiable(current);
    }
    if (!this.controlScopeMatches(parsed.data, current, state)) {
      this.options.onControlRejected?.('control_scope_mismatch');
      return { outcome: 'scope_mismatch' };
    }
    if (parsed.data.sequence <= this.controlBaseline(current)) {
      return { outcome: 'stale' };
    }
    return { outcome: 'accepted', next: { accepted: parsed.data, localHalt: null } };
  }

  private unverifiable(
    current: RuntimeControlState,
  ): { outcome: RuntimeControlOutcome; next?: RuntimeControlState } {
    this.options.onControlRejected?.('control_unverifiable');
    if (current.localHalt) return { outcome: 'unverifiable' };
    return {
      outcome: 'unverifiable',
      next: {
        accepted: current.accepted,
        localHalt: {
          kind: 'local',
          assistant: 'halted',
          reasonCode: 'control_unverifiable',
          sequence: this.controlBaseline(current),
          detectedAt: new Date().toISOString(),
        },
      },
    };
  }

  private controlBaseline(current: RuntimeControlState): number {
    return Math.max(current.accepted?.sequence ?? 0, current.localHalt?.sequence ?? 0);
  }

  private controlScopeMatches(
    control: EnvironmentControl,
    current: RuntimeControlState,
    state: RuntimeSyncState,
  ): boolean {
    const knownTenantId = current.accepted?.tenantId
      ?? state.stable?.agentRevision.tenantId;
    return control.environmentId === this.options.environmentId
      && (this.options.targetAppId === undefined
        || control.targetAppId === this.options.targetAppId)
      && (knownTenantId === undefined || control.tenantId === knownTenantId);
  }

  private deploymentScopeMatches(deployment: RuntimeDeploymentBundle): boolean {
    const revisions = [
      deployment.agentRevision,
      deployment.manifestRevision,
      deployment.policyRevision,
    ];
    const first = revisions[0];
    return deployment.environmentId === this.options.environmentId
      && deployment.manifestRevision.environmentId === this.options.environmentId
      && deployment.policyRevision.environmentId === this.options.environmentId
      && revisions.every((revision) => (
        revision.tenantId === first.tenantId
        && revision.targetAppId === first.targetAppId
      ));
  }

  private latest(
    deployments: RuntimeDeploymentBundle[],
    mode: 'stable' | 'canary',
  ): RuntimeDeploymentBundle | null {
    return deployments
      .filter((deployment) => deployment.rolloutMode === mode)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
      ?? null;
  }

  private mergePending(
    current: RuntimeDeploymentBundle[],
    accepted: RuntimeDeploymentBundle[],
  ): RuntimeDeploymentBundle[] {
    const byId = new Map(current.map((deployment) => [
      deployment.deploymentId,
      deployment,
    ]));
    for (const deployment of accepted) byId.set(deployment.deploymentId, deployment);
    return [...byId.values()];
  }

  private objectId(value: unknown, key: string): string {
    if (
      value
      && typeof value === 'object'
      && key in value
      && typeof (value as Record<string, unknown>)[key] === 'string'
    ) {
      return (value as Record<string, string>)[key];
    }
    return 'unknown';
  }

  private emptyState(): RuntimeSyncState {
    return {
      cursor: null,
      stable: null,
      canary: null,
      pending: [],
      revocations: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}
