import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RolloutBinding } from '../../contracts/rollout-binding.js';
import type { RuntimeDeploymentBundle, SecurityRevocation } from '../../contracts/revisions.js';
import {
  canaryState,
  RolloutCohortSelector,
  rolloutCohortBucket,
  selectRuntimeDeployment,
  stableCohortBucket,
} from '../deployment-selector.js';

const ENVIRONMENT_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3900';
const SALT = 'q3Zr8Kc1VtW0xYbHnL5pJg';

function binding(deployment: Pick<RuntimeDeploymentBundle, 'deploymentId' | 'rolloutMode' | 'targetPercentage'>, salt = SALT): RolloutBinding {
  return {
    kind: 'rollout-binding', schemaVersion: 1, deploymentId: deployment.deploymentId, environmentId: ENVIRONMENT_ID,
    rolloutMode: deployment.rolloutMode, targetPercentage: deployment.targetPercentage, cohortSalt: salt,
    issuedAt: '2026-11-26T09:00:00.000Z', signature: { algorithm: 'Ed25519', keyId: 'k', value: 'verified-in-sync' },
  };
}

function deployment(
  suffix: string,
  rolloutMode: 'stable' | 'canary',
  targetPercentage: number,
  patch: Partial<RuntimeDeploymentBundle> = {},
): RuntimeDeploymentBundle {
  const base = {
    deploymentId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix}`,
    environmentId: ENVIRONMENT_ID,
    rolloutMode,
    targetPercentage,
    pinned: false,
    agentRevision: { revisionId: `019fa9a9-d5f7-7ec3-a3c7-8899de1e${suffix}` },
    policyRevision: { revisionId: `019fa9a9-d5f7-7ec3-a3c7-8899de1f${suffix}` },
    promptDigest: 'sha256:prompt-a',
  } as unknown as RuntimeDeploymentBundle;
  return { ...base, rolloutBinding: binding(base), ...patch };
}

const stable = deployment('3901', 'stable', 100);
const canary = deployment('3902', 'canary', 10);
const subjects = Array.from({ length: 2_000 }, (_, index) => `user-${index}`);
const subjectIn = (from: number, to: number, salt = SALT) => subjects.find((subject) => {
  const bucket = rolloutCohortBucket(salt, subject);
  return bucket >= from && bucket < to;
})!;

describe('rollout cohort bucket', () => {
  it('keeps the unsalted bucket of earlier releases', () => {
    expect(stableCohortBucket('user-1')).toBe(stableCohortBucket('user-1'));
    expect(stableCohortBucket('user-1')).toBeGreaterThanOrEqual(0);
    expect(stableCohortBucket('user-1')).toBeLessThan(100);
  });

  it('puts 8 to 12 percent of 10,000 random subjects into a 10 percent canary', () => {
    const selector = new RolloutCohortSelector();
    let inCanary = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const subjectId = randomUUID();
      const selection = selector.select({ stable, canary }, { subjectId, conversationId: subjectId });
      if (selection?.cohort === 'canary') inCanary += 1;
    }
    expect(inCanary).toBeGreaterThanOrEqual(800);
    expect(inCanary).toBeLessThanOrEqual(1_200);
  });
});

describe('RolloutCohortSelector', () => {
  it('keeps one cohort per user across turns, conversations and a restart', () => {
    const inside = subjectIn(0, 10);
    const outside = subjectIn(10, 100);
    const first = new RolloutCohortSelector();
    const restarted = new RolloutCohortSelector();
    for (const conversationId of ['c-1', 'c-2', 'c-3']) {
      expect(first.select({ stable, canary }, { subjectId: inside, conversationId })).toEqual({ deployment: canary, cohort: 'canary' });
      expect(first.select({ stable, canary }, { subjectId: outside, conversationId: `${conversationId}-b` }))
        .toEqual({ deployment: stable, cohort: 'stable' });
    }
    expect(restarted.select({ stable, canary }, { subjectId: inside, conversationId: 'c-9' })?.cohort).toBe('canary');
  });

  it('falls back to the conversation as subject without a user', () => {
    const selector = new RolloutCohortSelector();
    const conversationId = subjectIn(0, 10);
    expect(selector.select({ stable, canary }, { conversationId })?.cohort).toBe('canary');
  });

  it('keeps a running conversation on its deployment when the percentage changes; a new one follows it', () => {
    const subjectId = subjectIn(10, 50);
    const selector = new RolloutCohortSelector();
    expect(selector.select({ stable, canary }, { subjectId, conversationId: 'running' })?.cohort).toBe('stable');

    const widened = deployment('3902', 'canary', 50);
    expect(selector.select({ stable, canary: widened }, { subjectId, conversationId: 'running' })?.cohort).toBe('stable');
    expect(selector.select({ stable, canary: widened }, { subjectId, conversationId: 'new' }))
      .toEqual({ deployment: widened, cohort: 'canary' });

    const narrowed = deployment('3902', 'canary', 5);
    expect(selector.select({ stable, canary: narrowed }, { subjectId, conversationId: 'new' }))
      .toEqual({ deployment: narrowed, cohort: 'canary' });
  });

  it('keeps a conversation on a promoted canary and moves one of the replaced stable to the new stable', () => {
    const onCanary = subjectIn(0, 10);
    const onStable = subjectIn(10, 100);
    const selector = new RolloutCohortSelector();
    selector.select({ stable, canary }, { subjectId: onCanary, conversationId: 'a' });
    selector.select({ stable, canary }, { subjectId: onStable, conversationId: 'b' });

    const promoted = deployment('3902', 'stable', 100);
    expect(selector.select({ stable: promoted, canary: null }, { subjectId: onCanary, conversationId: 'a' }))
      .toEqual({ deployment: promoted, cohort: 'stable' });
    expect(selector.select({ stable: promoted, canary: null }, { subjectId: onStable, conversationId: 'b' }))
      .toEqual({ deployment: promoted, cohort: 'stable' });
  });

  it('moves a conversation to stable on its next turn once the canary is withdrawn or revoked', () => {
    const subjectId = subjectIn(0, 10);
    const selector = new RolloutCohortSelector();
    expect(selector.select({ stable, canary }, { subjectId, conversationId: 'withdrawn' })?.cohort).toBe('canary');
    expect(selector.select({ stable, canary: null }, { subjectId, conversationId: 'withdrawn' })?.cohort).toBe('stable');
    expect(selector.select({ stable, canary }, { subjectId, conversationId: 'withdrawn' })?.cohort).toBe('stable');

    expect(selector.select({ stable, canary }, { subjectId, conversationId: 'revoked' })?.cohort).toBe('canary');
    const revocation = {
      environmentId: ENVIRONMENT_ID, effectiveAt: '2026-11-26T09:00:00.000Z', toolIds: [],
      agentRevisionIds: [canary.agentRevision.revisionId], policyRevisionIds: [],
    } as unknown as SecurityRevocation;
    expect(selector.select({ stable, canary, revocations: [revocation] }, { subjectId, conversationId: 'revoked' })?.cohort)
      .toBe('stable');
  });

  it.each([
    ['without a binding', deployment('3902', 'canary', 10, { rolloutBinding: undefined })],
    ['with a binding of another deployment', deployment('3902', 'canary', 10, {
      rolloutBinding: binding({ deploymentId: stable.deploymentId, rolloutMode: 'canary', targetPercentage: 10 }),
    })],
    ['with a binding of another share', deployment('3902', 'canary', 10, {
      rolloutBinding: binding({ deploymentId: canary.deploymentId, rolloutMode: 'canary', targetPercentage: 90 }),
    })],
  ])('never selects a canary %s', (_label, unbound) => {
    const selector = new RolloutCohortSelector();
    for (const subjectId of subjects.slice(0, 300)) {
      expect(selector.select({ stable, canary: unbound }, { subjectId, conversationId: subjectId })?.cohort).toBe('stable');
    }
    expect(canaryState({ stable, canary: unbound })).toBe('unbound');
  });

  it('never selects a bound canary while the stable deployment is unbound', () => {
    const unboundStable = deployment('3901', 'stable', 100, { rolloutBinding: undefined });
    const wide = deployment('3902', 'canary', 99);
    const selector = new RolloutCohortSelector();
    for (const subjectId of subjects.slice(0, 300)) {
      expect(selector.select({ stable: unboundStable, canary: wide }, { subjectId, conversationId: subjectId })?.cohort)
        .toBe('stable');
    }
    expect(canaryState({ stable: unboundStable, canary: wide })).toBe('unbound');
    expect(selectRuntimeDeployment({ stable: unboundStable, canary: wide }, { subjectId: subjectIn(0, 99) }))
      .toBe(unboundStable);
  });

  it('keeps at most the per-subject cap of conversations of one subject', () => {
    const selector = new RolloutCohortSelector({ maxConversationsPerSubject: 3 });
    selector.select({ stable, canary }, { subjectId: 'bob', conversationId: 'bob-1' });
    for (let index = 0; index < 50; index += 1) {
      selector.select({ stable, canary }, { subjectId: 'alice', conversationId: `${'c'.repeat(100_000)}-${index}` });
    }
    expect(selector.size).toBe(4);
  });

  it('never selects a canary whose prompt this runner does not hold', () => {
    const otherPrompt = deployment('3902', 'canary', 99, { promptDigest: 'sha256:prompt-b' });
    const selector = new RolloutCohortSelector();
    for (const subjectId of subjects.slice(0, 300)) {
      expect(selector.select({ stable, canary: otherPrompt }, { subjectId, conversationId: subjectId })?.cohort).toBe('stable');
    }
    expect(canaryState({ stable, canary: otherPrompt })).toBe('prompt-unavailable');
    expect(canaryState({ stable, canary: otherPrompt }, { promptAvailable: (digest) => digest === 'sha256:prompt-b' }))
      .toBe('selectable');
    expect(canaryState({ stable, canary })).toBe('selectable');
    expect(canaryState({ stable, canary: null })).toBeUndefined();
  });

  it('has nothing to select without a stable deployment', () => {
    expect(new RolloutCohortSelector().select({ stable: null, canary }, { subjectId: 'alice', conversationId: 'c' }))
      .toBeUndefined();
  });

  it('forgets a conversation after its time to live and bounds what it keeps', () => {
    let now = 0;
    const subjectId = subjectIn(10, 50);
    const selector = new RolloutCohortSelector({ ttlMs: 1_000, maxConversations: 2, now: () => now });
    selector.select({ stable, canary }, { subjectId, conversationId: 'old' });
    const widened = deployment('3902', 'canary', 50);
    now = 999;
    expect(selector.select({ stable, canary: widened }, { subjectId, conversationId: 'old' })?.cohort).toBe('stable');
    now = 2_000;
    expect(selector.select({ stable, canary: widened }, { subjectId, conversationId: 'old' })?.cohort).toBe('canary');

    selector.select({ stable, canary }, { subjectId, conversationId: 'x' });
    selector.select({ stable, canary }, { subjectId, conversationId: 'y' });
    selector.select({ stable, canary }, { subjectId, conversationId: 'z' });
    expect(selector.size).toBe(2);
  });
});

describe('selectRuntimeDeployment', () => {
  it('uses the bound canary only for its salted cohort and otherwise preserves stable', () => {
    expect(selectRuntimeDeployment({ stable, canary }, { subjectId: subjectIn(0, 10) })).toBe(canary);
    expect(selectRuntimeDeployment({ stable, canary }, { subjectId: subjectIn(10, 100) })).toBe(stable);
    const unbound = deployment('3902', 'canary', 99, { rolloutBinding: undefined });
    expect(selectRuntimeDeployment({ stable, canary: unbound }, { subjectId: subjectIn(0, 10) })).toBe(stable);
  });

  it('honors an explicit valid pin and fails closed without a stable fallback', () => {
    const pinned = { ...stable, pinned: true };
    expect(selectRuntimeDeployment({ stable: pinned, canary }, {
      subjectId: 'user-1',
      pinnedDeploymentId: pinned.deploymentId,
    })).toBe(pinned);
    expect(() => selectRuntimeDeployment({ stable: null, canary }, {
      subjectId: 'user-outside',
    })).toThrow(/stable deployment/i);
  });
});
