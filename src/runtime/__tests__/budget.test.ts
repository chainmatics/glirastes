import { describe, expect, it } from 'vitest';
import { ExecutionBudgetTracker } from '../budget.js';
import { createExecutionFingerprint } from '../fingerprint.js';
import { localLimits } from './turn-snapshot.test.js';

describe('ExecutionBudgetTracker', () => {
  it('emits a soft signal at 80 percent without stopping execution', () => {
    const tracker = new ExecutionBudgetTracker({
      ...localLimits,
      maxToolCalls: 10,
    });

    for (let index = 0; index < 8; index += 1) tracker.recordToolCall();

    expect(tracker.evaluate()).toMatchObject({
      state: 'soft-limit',
      reasons: ['maxToolCalls'],
    });
  });

  it('hard-stops at 100 percent and grants one bounded final summary', () => {
    const tracker = new ExecutionBudgetTracker({
      ...localLimits,
      maxToolCalls: 2,
    });

    tracker.recordToolCall();
    tracker.recordToolCall();

    expect(tracker.evaluate()).toMatchObject({
      state: 'hard-limit',
      reasons: ['maxToolCalls'],
    });
    expect(tracker.claimFinalSummary()).toBe(true);
    expect(tracker.claimFinalSummary()).toBe(false);
  });

  it('stops after the configured consecutive error threshold', () => {
    const tracker = new ExecutionBudgetTracker({
      ...localLimits,
      maxConsecutiveErrors: 2,
    });

    tracker.recordError();
    tracker.recordError();

    expect(tracker.evaluate().reasons).toContain('maxConsecutiveErrors');
    tracker.recordSuccess();
    expect(tracker.usage.consecutiveErrors).toBe(0);
  });

  it('tracks tokens, cost, model steps, and elapsed runtime', () => {
    const tracker = new ExecutionBudgetTracker(localLimits, {
      now: () => 120_000,
      startedAtMs: 0,
    });
    tracker.recordModelStep();
    tracker.recordTokens(200, 50);
    tracker.recordEstimatedCost(0.25);

    expect(tracker.usage).toMatchObject({
      modelSteps: 1,
      inputTokens: 200,
      outputTokens: 50,
      estimatedCostUsd: 0.25,
    });
    expect(tracker.evaluate().reasons).toContain('totalTimeoutMs');
  });

  it('rejects non-finite usage instead of bypassing limits', () => {
    const tracker = new ExecutionBudgetTracker(localLimits);

    expect(() => tracker.recordTokens(Number.NaN, 1)).toThrow(/finite/i);
    expect(() => tracker.recordEstimatedCost(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it('detects repeated tool, arguments, result, and progress fingerprints', () => {
    const tracker = new ExecutionBudgetTracker({
      ...localLimits,
      maxRepeatedFingerprint: 2,
    });
    const fingerprint = createExecutionFingerprint({
      toolId: 'list_tasks',
      arguments: { page: 1, filter: { status: 'open', owner: 'me' } },
      result: { ids: ['a', 'b'] },
      progress: { nextPage: 2 },
    });
    const reordered = createExecutionFingerprint({
      toolId: 'list_tasks',
      arguments: { filter: { owner: 'me', status: 'open' }, page: 1 },
      result: { ids: ['a', 'b'] },
      progress: { nextPage: 2 },
    });

    expect(fingerprint).toBe(reordered);
    tracker.recordFingerprint(fingerprint);
    tracker.recordFingerprint(reordered);
    expect(tracker.evaluate().reasons).toContain('maxRepeatedFingerprint');
  });
});
