import { describe, expect, it } from 'vitest';
import { ExecutionBudgetSchema } from '../../contracts/index.js';
import { DEFAULT_LOCAL_LIMITS, resolveLocalLimits } from '../local-limits.js';

describe('resolveLocalLimits', () => {
  it('falls back to a valid default budget', () => {
    expect(resolveLocalLimits()).toEqual(DEFAULT_LOCAL_LIMITS);
    expect(ExecutionBudgetSchema.parse(DEFAULT_LOCAL_LIMITS)).toEqual(DEFAULT_LOCAL_LIMITS);
    expect(DEFAULT_LOCAL_LIMITS).toMatchObject({
      maxModelSteps: 6, maxToolCalls: 8, totalTimeoutMs: 60_000, toolTimeoutMs: 15_000,
      maxInputTokens: 40_000, maxOutputTokens: 4_000, maxEstimatedCostUsd: 0.5,
      maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
      delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
    });
  });

  it('merges partial overrides, delegation included', () => {
    const limits = resolveLocalLimits({ maxToolCalls: 2, delegation: { maxDepth: 3 } });
    expect(limits.maxToolCalls).toBe(2);
    expect(limits.maxModelSteps).toBe(6);
    expect(limits.delegation).toEqual({ maxDepth: 3, maxBreadth: 1, sharedBudget: true });
  });

  it('ignores undefined fields', () => {
    expect(resolveLocalLimits({ maxToolCalls: undefined })).toEqual(DEFAULT_LOCAL_LIMITS);
  });
});
