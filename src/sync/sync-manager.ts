import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';
import type { RuntimeRevisionVerifier } from './signature-verifier.js';
import {
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
}).strict();

export interface RuntimeSyncApplyResult {
  state: RuntimeSyncState;
  rejectedDeploymentIds: string[];
  rejectedRevocationIds: string[];
}

export class RuntimeSyncManager {
  constructor(private readonly options: {
    environmentId: string;
    store: RuntimeStateStore;
    verifier: RuntimeRevisionVerifier;
    validateDeployment?: (
      deployment: RuntimeDeploymentBundle,
      revisions: MaterializedDeploymentRevisions,
    ) => void | Promise<void>;
    onRevocations?: (revocations: SecurityRevocation[]) => void | Promise<void>;
    onPending?: (deployments: RuntimeDeploymentBundle[]) => void | Promise<void>;
    onActivated?: (deployments: RuntimeDeploymentBundle[]) => void | Promise<void>;
  }) {}

  async apply(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
    const wire = WireSyncBundleSchema.parse(rawBundle);
    let state = await this.options.store.load() ?? this.emptyState();
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

    return { state, rejectedDeploymentIds, rejectedRevocationIds };
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
