import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';
import type { RuntimeRevisionVerifier } from './signature-verifier.js';
import {
  type RuntimePrivacyFloor,
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
  /** Deployments refused because they would lower the privacy floor (`privacy_policy_downgrade`). */
  privacyDowngradeDeploymentIds: string[];
  /** Deployments whose protected block this runner cannot enforce (`privacy_refused`). */
  privacyRefusedDeploymentIds: string[];
}

/**
 * Thrown by `validateDeployment` when this runner cannot enforce the
 * protected privacy block of a verified deployment. The deployment is
 * rejected and recorded in `privacyRefusedDeploymentIds` of the state, which
 * blocks AI traffic until the Platform stops offering it or it is accepted.
 */
export class PrivacyRefusedError extends Error {
  constructor() {
    super('privacy_refused');
    this.name = 'PrivacyRefusedError';
  }
}

/** Thrown inside deployment validation when a revision would lower the privacy floor. */
class PrivacyDowngradeError extends Error {
  constructor() {
    super('privacy_policy_downgrade');
    this.name = 'PrivacyDowngradeError';
  }
}

/**
 * Whether a verified deployment may be accepted under the floor. Below a
 * protected floor a revision needs a protected block, or an explicitly
 * signed `off` that is newer than the floor and not revoked; an older,
 * validly signed `off` (replay) is refused.
 */
function lowersPrivacyFloor(
  floor: RuntimePrivacyFloor | null | undefined,
  revisions: MaterializedDeploymentRevisions,
  revocations: ReadonlyArray<SecurityRevocation>,
): boolean {
  const policy = revisions.policyRevision;
  const block = policy.privacy;
  const revoked = revocations.some((revocation) => revocation.policyRevisionIds.includes(policy.revisionId));
  if (block?.profile === 'off' && revoked) return true;
  if (floor?.profile !== 'protected-text/v1') return false;
  if (!block) return true;
  if (block.profile !== 'off') return false;
  return policy.revision <= floor.policyRevision;
}

/**
 * The floor after the given deployments became the accepted active state.
 * Its revision number is a high-water mark: protection re-enabled by a
 * rollback to an older protected revision keeps the highest number seen, so
 * only an `off` signed after everything accepted before lowers it again.
 */
function nextPrivacyFloor(
  floor: RuntimePrivacyFloor | null | undefined,
  active: ReadonlyArray<{ deploymentId: string; revisions: MaterializedDeploymentRevisions }>,
): RuntimePrivacyFloor | null {
  let next = floor ?? null;
  const ordered = [...active].sort((left, right) => left.revisions.policyRevision.revision - right.revisions.policyRevision.revision);
  for (const { deploymentId, revisions } of ordered) {
    const policy = revisions.policyRevision;
    const profile = policy.privacy?.profile;
    if (!profile) continue;
    const record = { deploymentId, revisionId: policy.revisionId };
    if (profile === 'protected-text/v1') {
      next = next?.profile === 'protected-text/v1' && next.policyRevision >= policy.revision
        ? next
        : { profile, policyRevision: Math.max(policy.revision, next?.policyRevision ?? 0), ...record };
    } else if (!next || policy.revision > next.policyRevision) {
      next = { profile, policyRevision: policy.revision, ...record };
    }
  }
  return next;
}

/**
 * The floor after a verified, in-scope protected revision was rejected (not
 * enforceable here, or failing local validation): protected, at the
 * high-water mark. A protected floor at a higher revision stays.
 */
function raisedByRejection(
  floor: RuntimePrivacyFloor | null | undefined,
  deploymentId: string,
  revisions: MaterializedDeploymentRevisions,
): RuntimePrivacyFloor | null {
  const policy = revisions.policyRevision;
  if (policy.privacy?.profile !== 'protected-text/v1') return floor ?? null;
  if (floor?.profile === 'protected-text/v1' && policy.revision <= floor.policyRevision) return floor;
  return {
    profile: 'protected-text/v1',
    policyRevision: Math.max(policy.revision, floor?.policyRevision ?? 0),
    deploymentId,
    revisionId: policy.revisionId,
  };
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
    /** Deployments refused because they would lower the privacy floor. */
    onPrivacyDowngrade?: (deploymentIds: string[]) => void | Promise<void>;
  }) {}

  private applying: Promise<unknown> = Promise.resolve();

  /**
   * Applies one sync bundle. Calls run one after another (poll and push may
   * overlap), so no update reads a state another one is about to replace.
   */
  apply(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
    const run = this.applying.then(() => this.applyOne(rawBundle));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async applyOne(rawBundle: unknown): Promise<RuntimeSyncApplyResult> {
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
    const materializedById = new Map<string, MaterializedDeploymentRevisions>();
    const rejectedDeploymentIds: string[] = [];
    const privacyDowngradeDeploymentIds: string[] = [];
    const privacyRefusedDeploymentIds: string[] = [];
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
      let verified: MaterializedDeploymentRevisions | undefined;
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
        verified = materialized;
        if (lowersPrivacyFloor(state.privacyFloor, materialized, state.revocations)) {
          throw new PrivacyDowngradeError();
        }
        await this.options.validateDeployment?.(parsed.data, materialized);
        acceptedDeployments.push(parsed.data);
        materializedById.set(parsed.data.deploymentId, materialized);
      } catch (error) {
        if (error instanceof PrivacyDowngradeError) privacyDowngradeDeploymentIds.push(parsed.data.deploymentId);
        if (error instanceof PrivacyRefusedError) privacyRefusedDeploymentIds.push(parsed.data.deploymentId);
        // A verified, in-scope protected requirement that is rejected, for
        // whatever reason, raises the floor: withdrawing it later never leads
        // back to an unprotected revision; only a newer protected policy this
        // runner accepts or a newer signed `off` lifts it. Material with a bad
        // signature or another scope never gets here (`verified` is unset).
        if (verified && !(error instanceof PrivacyDowngradeError)) {
          state = { ...state, privacyFloor: raisedByRejection(state.privacyFloor, parsed.data.deploymentId, verified) };
        }
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
      const stable = this.latest(active, 'stable');
      const canary = this.latest(active, 'canary');
      const now = [stable, canary]
        .filter((deployment): deployment is RuntimeDeploymentBundle => deployment !== null)
        .map((deployment) => ({ deploymentId: deployment.deploymentId, revisions: materializedById.get(deployment.deploymentId)! }));
      // The floor is part of the accepted state and saved with it below.
      state = {
        ...state,
        stable,
        canary,
        privacyFloor: nextPrivacyFloor(state.privacyFloor, now),
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
      // Every bundle is a complete snapshot: the refusals it produced replace
      // the earlier ones, so a deployment the Platform withdrew unlocks.
      privacyRefusedDeploymentIds: privacyRefusedDeploymentIds.slice(-64),
      cursor: wire.cursor,
      updatedAt: wire.cursor,
    };
    await this.options.store.saveAtomic(state);
    if (privacyDowngradeDeploymentIds.length > 0) {
      await this.options.onPrivacyDowngrade?.(privacyDowngradeDeploymentIds);
    }
    if (pending.length > 0) await this.options.onPending?.(pending);
    if (active.length > 0 && !rejectedActive) {
      await this.options.onActivated?.(active);
    }

    return {
      state,
      rejectedDeploymentIds,
      rejectedRevocationIds,
      privacyDowngradeDeploymentIds,
      privacyRefusedDeploymentIds,
    };
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
