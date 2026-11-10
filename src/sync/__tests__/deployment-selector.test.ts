import { describe, expect, it } from 'vitest';
import type { RuntimeDeploymentBundle } from '../../contracts/revisions.js';
import {
  selectRuntimeDeployment,
  stableCohortBucket,
} from '../deployment-selector.js';

const stable = {
  deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
  rolloutMode: 'stable',
  targetPercentage: 100,
  pinned: true,
} as RuntimeDeploymentBundle;
const canary = {
  deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  rolloutMode: 'canary',
  targetPercentage: 10,
  pinned: false,
} as RuntimeDeploymentBundle;

describe('deployment selection', () => {
  it('assigns subjects to a deterministic 0-99 cohort', () => {
    expect(stableCohortBucket('user-1')).toBe(stableCohortBucket('user-1'));
    expect(stableCohortBucket('user-1')).toBeGreaterThanOrEqual(0);
    expect(stableCohortBucket('user-1')).toBeLessThan(100);
  });

  it('uses canary only for its cohort and otherwise preserves stable', () => {
    const canarySubject = Array.from({ length: 1_000 }, (_, index) => `user-${index}`)
      .find((subject) => stableCohortBucket(subject) < 10)!;
    const stableSubject = Array.from({ length: 1_000 }, (_, index) => `user-${index}`)
      .find((subject) => stableCohortBucket(subject) >= 10)!;
    expect(selectRuntimeDeployment({ stable, canary }, {
      subjectId: canarySubject,
    })).toBe(canary);
    expect(selectRuntimeDeployment({ stable, canary }, {
      subjectId: stableSubject,
    })).toBe(stable);
  });

  it('honors an explicit valid pin and fails closed without a stable fallback', () => {
    expect(selectRuntimeDeployment({ stable, canary }, {
      subjectId: 'user-1',
      pinnedDeploymentId: stable.deploymentId,
    })).toBe(stable);
    expect(() => selectRuntimeDeployment({ stable: null, canary }, {
      subjectId: 'user-outside',
    })).toThrow(/stable deployment/i);
  });
});
