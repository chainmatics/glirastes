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
  canonicalRuntimeJson,
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
 * `stale` (nothing newer), `unverifiable` (local halt).
 */
export type RuntimeControlOutcome =
  | 'absent'
  | 'kept'
  | 'accepted'
  | 'stale'
  | 'unverifiable';

export type RuntimeEnvironmentControlErrorCode =
  | 'control_unverifiable'
  | 'control_scope_mismatch'
  | 'control_sequence_conflict';

const CONTROL_ERROR_MESSAGES: Record<RuntimeEnvironmentControlErrorCode, string> = {
  control_unverifiable: 'Glirastes environment control could not be verified; the assistant is halted',
  control_scope_mismatch: 'Glirastes environment control names another tenant, app or environment; the assistant is halted',
  control_sequence_conflict: 'Glirastes environment control changed without a new sequence; the assistant is halted',
};

/** Content-free report of a delivered control the runner did not accept. */
export class RuntimeEnvironmentControlError extends Error {
  constructor(readonly code: RuntimeEnvironmentControlErrorCode) {
    super(CONTROL_ERROR_MESSAGES[code]);
    this.name = 'RuntimeEnvironmentControlError';
  }
}

type ControlDecision = { outcome: RuntimeControlOutcome; next?: RuntimeControlState };

const NO_CONTROL: RuntimeControlState = { accepted: null, localHalt: null };

function sameControlState(
  left: RuntimeControlState | undefined,
  right: RuntimeControlState | undefined,
): boolean {
  return canonicalRuntimeJson(left ?? null) === canonicalRuntimeJson(right ?? null);
}

function unsignedControlJson(control: EnvironmentControl): string {
  const { signature: _signature, ...unsigned } = control;
  return canonicalRuntimeJson(unsigned);
}

export interface RuntimeSyncApplyResult {
  state: RuntimeSyncState;
  rejectedDeploymentIds: string[];
  rejectedRevocationIds: string[];
  control: RuntimeControlOutcome;
}

export class RuntimeSyncManager {
  private queue: Promise<unknown> = Promise.resolve();

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

  /** Poll and push may overlap; each apply runs load, work and save exclusively. */
  apply(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
    const run = this.queue.then(() => this.applyExclusive(rawBundle));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyExclusive(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
    const wire = WireSyncBundleSchema.parse(rawBundle);
    let state = await this.options.store.load() ?? this.emptyState();
    const foreign = state.control?.accepted;
    if (foreign && foreign.environmentId !== this.options.environmentId) {
      // Never a baseline for this environment, and never silently dropped.
      this.options.onControlRejected?.('control_scope_mismatch');
      state = {
        ...state,
        control: {
          accepted: null,
          localHalt: {
            kind: 'local',
            assistant: 'halted',
            reasonCode: 'control_unverifiable',
            sequence: 0,
            detectedAt: new Date().toISOString(),
          },
        },
      };
      await this.options.store.saveAtomic(state);
    }
    // First, so a failed key lookup aborts the sync before anything else applies.
    let controlResult = await this.applyControl(wire, state);
    if (controlResult.next) {
      // Another writer of the same store may have moved the control meanwhile.
      const fresh = (await this.options.store.load())?.control;
      if (!sameControlState(fresh, state.control)) {
        controlResult = this.mergeConcurrent(fresh ?? NO_CONTROL, controlResult);
      }
      state = { ...state, control: controlResult.next ?? fresh };
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
      state = await this.saveKeepingControl(state);
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
        acceptedDeployments.push(await this.withVerifiedRolloutBinding(parsed.data));
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
    state = await this.saveKeepingControl(state);
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

  private async saveKeepingControl(state: RuntimeSyncState): Promise<RuntimeSyncState> {
    const fresh = await this.options.store.load();
    const next = fresh && !sameControlState(fresh.control, state.control)
      ? { ...state, control: this.newerControl(fresh.control ?? NO_CONTROL, state.control ?? NO_CONTROL) }
      : state;
    await this.options.store.saveAtomic(next);
    return next;
  }

  private newerControl(
    left: RuntimeControlState,
    right: RuntimeControlState,
  ): RuntimeControlState {
    const accepted = (left.accepted?.sequence ?? 0) >= (right.accepted?.sequence ?? 0)
      ? left.accepted
      : right.accepted;
    const acceptedSequence = accepted?.sequence ?? 0;
    // A newer accepted control supersedes a halt that sits below it.
    const halt = [left.localHalt, right.localHalt].find((candidate) => candidate && (
      candidate.sequence >= acceptedSequence || (candidate.failedSequence ?? 0) > acceptedSequence
    )) ?? null;
    return {
      accepted,
      localHalt: halt && {
        ...halt,
        sequence: Math.max(this.controlBaseline(left), this.controlBaseline(right)),
      },
    };
  }

  private mergeConcurrent(fresh: RuntimeControlState, decision: ControlDecision): ControlDecision {
    const next = decision.next!;
    if (next.localHalt) {
      return { outcome: 'unverifiable', next: this.newerControl(fresh, next) };
    }
    if ((next.accepted?.sequence ?? 0) > this.controlBaseline(fresh)) return decision;
    return { outcome: 'stale', next: fresh };
  }

  private async applyControl(
    wire: z.infer<typeof WireSyncBundleSchema>,
    state: RuntimeSyncState,
  ): Promise<ControlDecision> {
    if (!('control' in wire)) return { outcome: 'absent' };
    if (wire.control === null) return { outcome: 'kept' };
    const current = state.control ?? NO_CONTROL;
    const parsed = EnvironmentControlSchema.safeParse(wire.control);
    if (!parsed.success) return this.unverifiable(current, 'control_unverifiable');
    const control = parsed.data;
    try {
      await this.options.verifier.verifyEnvironmentControl(control);
    } catch (error) {
      // A JWKS outage is no verdict on the control; retry with the next sync.
      if (!(error instanceof RuntimeSyncVerificationError)) throw error;
      return this.unverifiable(current, 'control_unverifiable', control.sequence);
    }
    if (!this.controlScopeMatches(control, current, state)) {
      return this.unverifiable(current, 'control_scope_mismatch');
    }
    const accepted = current.accepted;
    if (accepted && control.sequence === accepted.sequence) {
      if (unsignedControlJson(control) !== unsignedControlJson(accepted)) {
        return this.unverifiable(current, 'control_sequence_conflict');
      }
      // The halt came only from failing to verify this same control.
      if (current.localHalt?.failedSequence === accepted.sequence) {
        return { outcome: 'accepted', next: { accepted: control, localHalt: null } };
      }
      return { outcome: 'stale' };
    }
    if (control.sequence <= this.controlBaseline(current)) {
      return { outcome: 'stale' };
    }
    return { outcome: 'accepted', next: { accepted: control, localHalt: null } };
  }

  private unverifiable(
    current: RuntimeControlState,
    code: RuntimeEnvironmentControlErrorCode,
    failedSequence?: number,
  ): ControlDecision {
    this.options.onControlRejected?.(code);
    const halt = current.localHalt;
    if (halt) {
      // Any other failure makes the halt wait for a higher sequence.
      if (halt.failedSequence === undefined || halt.failedSequence === failedSequence) {
        return { outcome: 'unverifiable' };
      }
      const { failedSequence: _dropped, ...rest } = halt;
      return { outcome: 'unverifiable', next: { accepted: current.accepted, localHalt: rest } };
    }
    return {
      outcome: 'unverifiable',
      next: {
        accepted: current.accepted,
        localHalt: {
          kind: 'local',
          assistant: 'halted',
          reasonCode: 'control_unverifiable',
          sequence: this.controlBaseline(current),
          ...(failedSequence !== undefined ? { failedSequence } : {}),
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

  /** An unverifiable binding only costs the deployment its canary selection, never the deployment. */
  private async withVerifiedRolloutBinding(
    deployment: RuntimeDeploymentBundle,
  ): Promise<RuntimeDeploymentBundle> {
    const binding = deployment.rolloutBinding;
    if (!binding) return deployment;
    const { rolloutBinding: _dropped, ...unbound } = deployment;
    if (
      binding.deploymentId !== deployment.deploymentId
      || binding.environmentId !== this.options.environmentId
      || binding.rolloutMode !== deployment.rolloutMode
      || binding.targetPercentage !== deployment.targetPercentage
    ) {
      return unbound;
    }
    try {
      await this.options.verifier.verifyRolloutBinding(binding);
      return deployment;
    } catch {
      return unbound;
    }
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
