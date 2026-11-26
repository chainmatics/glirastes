import { createHash } from 'node:crypto';
import type { RuntimeDeploymentBundle, SecurityRevocation } from '../contracts/revisions.js';

const DEFAULT_MAX_CONVERSATIONS = 10_000;
const DEFAULT_CONVERSATION_TTL_MS = 24 * 60 * 60 * 1_000;

/** The unsalted bucket of earlier releases; canary selection uses `rolloutCohortBucket`. */
export function stableCohortBucket(subjectId: string): number {
  const digest = createHash('sha256').update(subjectId).digest();
  return digest.readUInt32BE(0) % 100;
}

/** The rollout bucket (0-99) of a subject: first 4 bytes of sha256(`salt:subject`) as UInt32BE, modulo 100. */
export function rolloutCohortBucket(cohortSalt: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${cohortSalt}:${subjectId}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

export type RolloutCohort = 'stable' | 'canary';

/**
 * Why the canary in the state is (not) selectable on this runner: `unbound`
 * (no valid rollout binding), `revoked` (its agent or policy revision is),
 * `prompt-unavailable` (its prompt digest is not one this runner holds).
 */
export type CanaryState = 'selectable' | 'unbound' | 'revoked' | 'prompt-unavailable';

export interface RolloutDeployments {
  stable: RuntimeDeploymentBundle | null;
  canary: RuntimeDeploymentBundle | null;
  revocations?: ReadonlyArray<SecurityRevocation>;
}

export interface CanaryStateOptions {
  /** Whether this runner holds the prompt of that digest; defaults to "the stable deployment's digest". */
  promptAvailable?: (promptDigest: string | undefined) => boolean;
  now?: () => number;
}

export interface RolloutSelection {
  deployment: RuntimeDeploymentBundle;
  cohort: RolloutCohort;
}

/** A canary binding that names exactly this deployment, its mode and its share. */
function boundCanary(deployment: RuntimeDeploymentBundle): boolean {
  const binding = deployment.rolloutBinding;
  return deployment.rolloutMode === 'canary'
    && binding !== undefined
    && binding.rolloutMode === 'canary'
    && binding.deploymentId === deployment.deploymentId
    && binding.environmentId === deployment.environmentId
    && binding.targetPercentage === deployment.targetPercentage;
}

function revoked(
  deployment: RuntimeDeploymentBundle,
  revocations: ReadonlyArray<SecurityRevocation>,
  now: number,
): boolean {
  return revocations.some((revocation) => revocation.environmentId === deployment.environmentId
    && Date.parse(revocation.effectiveAt) <= now
    && (revocation.agentRevisionIds.includes(deployment.agentRevision.revisionId)
      || revocation.policyRevisionIds.includes(deployment.policyRevision.revisionId)));
}

export function canaryState(
  deployments: RolloutDeployments,
  options: CanaryStateOptions = {},
): CanaryState | undefined {
  const { stable, canary } = deployments;
  if (!canary) return undefined;
  if (!boundCanary(canary)) return 'unbound';
  if (revoked(canary, deployments.revocations ?? [], (options.now ?? Date.now)())) return 'revoked';
  const promptAvailable = options.promptAvailable
    ?? ((digest: string | undefined) => digest === stable?.promptDigest);
  return promptAvailable(canary.promptDigest) ? 'selectable' : 'prompt-unavailable';
}

/**
 * Per-turn choice between the stable and the canary deployment. The cohort
 * follows the salted bucket of the subject; the first choice of a
 * conversation sticks while that deployment stays selectable. Kept in
 * process memory, bounded and expiring: not shared between instances.
 */
export class RolloutCohortSelector {
  private readonly conversations = new Map<string, { deploymentId: string; seenAt: number }>();
  private readonly maxConversations: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxConversations?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxConversations = Math.max(1, options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS);
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_CONVERSATION_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.conversations.size;
  }

  select(
    deployments: RolloutDeployments,
    input: { subjectId?: string; conversationId: string } & Pick<CanaryStateOptions, 'promptAvailable'>,
  ): RolloutSelection | undefined {
    const { stable, canary } = deployments;
    if (!stable) return undefined;
    const now = this.now();
    const selectable = canary && canaryState(deployments, {
      now: () => now,
      ...(input.promptAvailable ? { promptAvailable: input.promptAvailable } : {}),
    }) === 'selectable'
      ? canary
      : undefined;
    const sticky = this.conversations.get(input.conversationId);
    let selection: RolloutSelection;
    if (sticky && now - sticky.seenAt < this.ttlMs) {
      selection = selectable && sticky.deploymentId === selectable.deploymentId
        ? { deployment: selectable, cohort: 'canary' }
        : { deployment: stable, cohort: 'stable' };
    } else {
      const subjectId = input.subjectId || input.conversationId;
      selection = selectable
        && rolloutCohortBucket(selectable.rolloutBinding!.cohortSalt, subjectId) < selectable.rolloutBinding!.targetPercentage
        ? { deployment: selectable, cohort: 'canary' }
        : { deployment: stable, cohort: 'stable' };
    }
    this.remember(input.conversationId, selection.deployment.deploymentId, now);
    return selection;
  }

  private remember(conversationId: string, deploymentId: string, now: number): void {
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, { deploymentId, seenAt: now });
    for (const [key, entry] of this.conversations) {
      if (this.conversations.size <= this.maxConversations && now - entry.seenAt < this.ttlMs) break;
      this.conversations.delete(key);
    }
  }
}

export function selectRuntimeDeployment(
  deployments: {
    stable: RuntimeDeploymentBundle | null;
    canary: RuntimeDeploymentBundle | null;
  },
  input: {
    subjectId: string;
    pinnedDeploymentId?: string;
  },
): RuntimeDeploymentBundle {
  if (input.pinnedDeploymentId) {
    const available = [deployments.stable, deployments.canary].filter(
      (deployment): deployment is RuntimeDeploymentBundle => deployment !== null,
    );
    const pinned = available.find(
      (deployment) => (
        deployment.deploymentId === input.pinnedDeploymentId
        && deployment.pinned
      ),
    );
    if (!pinned) {
      throw new Error('Pinned runtime deployment is unavailable or not pinnable');
    }
    return pinned;
  }
  if (!deployments.stable) {
    throw new Error('No verified stable deployment is available');
  }
  const canary = deployments.canary;
  if (
    canary
    && boundCanary(canary)
    && rolloutCohortBucket(canary.rolloutBinding!.cohortSalt, input.subjectId)
      < canary.rolloutBinding!.targetPercentage
  ) {
    return canary;
  }
  return deployments.stable;
}
