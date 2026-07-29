import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SAFETY_MAX_STEPS,
  resolveStepLimit,
  shouldStopManagedExecution,
} from '../create-ai-chat-handler.js';

describe('resolveStepLimit', () => {
  it('uses 24 as the default safetyMaxSteps when nothing is configured', () => {
    expect(DEFAULT_SAFETY_MAX_STEPS).toBe(24);
    const result = resolveStepLimit({});
    expect(result).toEqual({ maxSteps: 24, stepLimitSource: 'safety' });
  });

  it('honours an explicit safetyMaxSteps override', () => {
    expect(resolveStepLimit({ safetyMaxSteps: 16 })).toEqual({
      maxSteps: 16,
      stepLimitSource: 'safety',
    });
  });

  it('prefers configuredMaxSteps over the safety default', () => {
    expect(resolveStepLimit({ configuredMaxSteps: 4 })).toEqual({
      maxSteps: 4,
      stepLimitSource: 'explicit',
    });
  });

  it('prefers moduleMaxSteps over configured and safety', () => {
    expect(
      resolveStepLimit({ moduleMaxSteps: 2, configuredMaxSteps: 4, safetyMaxSteps: 16 }),
    ).toEqual({ maxSteps: 2, stepLimitSource: 'module' });
  });

  it('never lets module or adapter settings exceed the pinned runtime budget', () => {
    expect(resolveStepLimit({
      moduleMaxSteps: 16,
      configuredMaxSteps: 12,
      safetyMaxSteps: 24,
      runtimeBudgetMaxSteps: 6,
    })).toEqual({
      maxSteps: 6,
      stepLimitSource: 'runtime-budget',
    });
  });

  it('falls back to safety when configured is non-positive or not a number', () => {
    expect(resolveStepLimit({ configuredMaxSteps: 0 })).toEqual({
      maxSteps: 24,
      stepLimitSource: 'safety',
    });
    expect(resolveStepLimit({ configuredMaxSteps: -3 })).toEqual({
      maxSteps: 24,
      stepLimitSource: 'safety',
    });
  });

  it('does not stop merely because different calls use the same tool name', () => {
    expect(shouldStopManagedExecution({
      stepCount: 3,
      maxSteps: 10,
      budgetState: 'within-budget',
    })).toBe(false);
    expect(shouldStopManagedExecution({
      stepCount: 3,
      maxSteps: 10,
      budgetState: 'hard-limit',
    })).toBe(true);
  });
});
