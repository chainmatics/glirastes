import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SAFETY_MAX_STEPS,
  resolveStepLimit,
} from '../create-ai-chat-handler.js';

describe('resolveStepLimit', () => {
  it('uses 8 as the default safetyMaxSteps when nothing is configured', () => {
    expect(DEFAULT_SAFETY_MAX_STEPS).toBe(8);
    const result = resolveStepLimit({});
    expect(result).toEqual({ maxSteps: 8, stepLimitSource: 'safety' });
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

  it('falls back to safety when configured is non-positive or not a number', () => {
    expect(resolveStepLimit({ configuredMaxSteps: 0 })).toEqual({
      maxSteps: 8,
      stepLimitSource: 'safety',
    });
    expect(resolveStepLimit({ configuredMaxSteps: -3 })).toEqual({
      maxSteps: 8,
      stepLimitSource: 'safety',
    });
  });
});
