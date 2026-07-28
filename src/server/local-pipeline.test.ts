import { describe, expect, it, vi } from 'vitest';
import type { ModuleDefinition } from '../types.js';
import { createLocalAiPipeline } from './local-pipeline.js';

const modules: ModuleDefinition[] = [{
  id: 'task_query',
  name: 'Task query',
  description: 'Read and search tasks.',
  tools: ['list_tasks'],
  classification: {
    hint: 'Read and search tasks',
    examples: ['show my tasks'],
  },
}];

const context = {
  currentDate: new Date('2026-07-28T20:00:00.000Z'),
  locale: 'de-DE',
};

describe('createLocalAiPipeline', () => {
  it('classifies, routes, and selects the model entirely locally', async () => {
    const generateText = vi.fn(async () => ({
      text: JSON.stringify({ moduleId: 'task_query', confidence: 0.98 }),
    }));
    const model = { provider: 'local-binding' };
    const pipeline = createLocalAiPipeline({
      modules,
      modelSelector: {
        fast: { modelId: 'fast', instance: model },
        standard: { modelId: 'standard', instance: model },
        premium: { modelId: 'premium', instance: model },
      },
      classifier: { modules, model },
      generateText,
      followups: { enabled: true },
    });

    const result = await pipeline.process('Zeige meine Aufgaben', context);

    expect(result).toMatchObject({
      blocked: false,
      intent: { intent: 'task_query', confidence: 0.98 },
      tools: ['list_tasks', 'suggest_followups'],
      model: { modelId: 'standard', instance: model },
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('blocks locally before classification and never includes raw input in audit', async () => {
    const generateText = vi.fn();
    const onAudit = vi.fn();
    const pipeline = createLocalAiPipeline({
      modules,
      guardrails: { maxInputLength: 5 },
      generateText,
      onAudit,
    });

    const result = await pipeline.process('sensitive raw input', context);

    expect(result.blocked).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
    expect(JSON.stringify(onAudit.mock.calls)).not.toContain('sensitive raw input');
  });

  it('bypasses model classification for promoted standalone inputs only', async () => {
    const generateText = vi.fn(async () => ({
      text: JSON.stringify({ moduleId: 'task_query', confidence: 0.98 }),
    }));
    const pipeline = createLocalAiPipeline({
      modules,
      classifier: { modules, model: {} },
      generateText,
      fastPath: {
        initialPatterns: [{
          pattern: 'zeige meine aufgaben',
          intent: 'task_query',
          confidence: 0.98,
          hitCount: 3,
          lastSeen: Date.now(),
          promotedAt: Date.now(),
        }],
      },
    });

    const fastResult = await pipeline.process(
      'Zeige meine Aufgaben',
      context,
    );
    await pipeline.process(
      'Zeige meine Aufgaben',
      context,
      [{ role: 'user', content: 'vorherige Frage' }],
    );

    expect(fastResult.intent).toEqual({
      intent: 'task_query',
      confidence: 0.95,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
