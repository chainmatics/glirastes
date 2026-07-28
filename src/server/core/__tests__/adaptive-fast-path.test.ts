import { describe, expect, it, vi } from 'vitest';
import {
  createAdaptiveFastPath,
  createInMemoryFastPathStorage,
} from '../adaptive-fast-path.js';

describe('createAdaptiveFastPath', () => {
  it('promotes repeated high-confidence standalone inputs', () => {
    const fastPath = createAdaptiveFastPath({
      promotionThreshold: 2,
      minConfidence: 0.8,
    });

    fastPath.learn('Zeige meine Aufgaben!', {
      intent: 'task_query',
      confidence: 0.95,
    });
    expect(fastPath.match('zeige   meine aufgaben')).toBeNull();

    fastPath.learn('zeige meine aufgaben', {
      intent: 'task_query',
      confidence: 0.9,
    });

    expect(fastPath.match('ZEIGE MEINE AUFGABEN.')).toEqual({
      intent: 'task_query',
      confidence: 0.95,
    });
  });

  it('does not learn ambiguous or low-confidence classifications', () => {
    const fastPath = createAdaptiveFastPath({
      promotionThreshold: 1,
      minConfidence: 0.8,
    });

    fastPath.learn('maybe', { intent: 'ambiguous', confidence: 1 });
    fastPath.learn('weak', { intent: 'task_query', confidence: 0.5 });

    expect(fastPath.getPatterns()).toEqual([]);
  });

  it('expires promoted patterns by local TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
    const fastPath = createAdaptiveFastPath({
      patternTtlMs: 1_000,
      initialPatterns: [{
        pattern: 'list tasks',
        intent: 'task_query',
        confidence: 0.98,
        hitCount: 3,
        lastSeen: Date.now(),
        promotedAt: Date.now(),
      }],
    });

    vi.advanceTimersByTime(1_001);

    expect(fastPath.match('list tasks')).toBeNull();
    vi.useRealTimers();
  });

  it('round-trips patterns through an optional local store', async () => {
    const storage = createInMemoryFastPathStorage();
    const first = createAdaptiveFastPath({
      promotionThreshold: 1,
    }, storage);
    first.learn('list tasks', {
      intent: 'task_query',
      confidence: 0.99,
    });
    await first.saveToStorage();

    const restored = createAdaptiveFastPath({}, storage);
    await restored.loadFromStorage();

    expect(restored.match('list tasks')).toMatchObject({
      intent: 'task_query',
    });
  });
});
