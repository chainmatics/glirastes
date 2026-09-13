import { describe, expect, it } from 'vitest';
import type { ModuleDefinition } from '../../../types.js';
import { createAiRouter } from '../module-router.js';

const modules: ModuleDefinition[] = [
  { id: 'tasks', name: 'Tasks', description: 'Tasks', tools: ['tasks_list'], sharedTools: ['users_lookup'] },
  { id: 'teams', name: 'Teams', description: 'Teams', tools: ['teams_delete'], sharedTools: ['teams_lookup'] },
  { id: 'billing', name: 'Billing', description: 'Billing', tools: ['invoice_send'], sharedTools: ['invoice_list'] },
];

describe('focused module routing', () => {
  const router = createAiRouter({
    modules,
    routingMode: 'focused',
    relatedModules: { tasks: ['teams', 'missing', 'teams'] },
  });

  it.each([
    { intent: 'ambiguous', confidence: 1 },
    { intent: 'unknown', confidence: 1 },
    { intent: 'tasks', confidence: 0.69 },
    { intent: 'tasks', confidence: Number.NaN },
    { intent: 'tasks', confidence: Number.POSITIVE_INFINITY },
    { intent: 'tasks', confidence: 1.1 },
  ])('does not expose the catalogue for $intent / $confidence', (intent) => {
    expect(router.route(intent, [])).toEqual({
      tools: [], module: null, strategy: 'none',
    });
  });

  it('includes explicit dependencies of a confident primary module', () => {
    expect(router.route({ intent: 'tasks', confidence: 0.95 }, [])).toMatchObject({
      tools: ['tasks_list', 'users_lookup'], strategy: 'single', module: { id: 'tasks' },
    });
  });

  it('expands only to shared tools of declared related modules', () => {
    expect(router.route({ intent: 'tasks', confidence: 0.75 }, [])).toMatchObject({
      tools: ['tasks_list', 'users_lookup', 'teams_lookup'], strategy: 'expanded',
    });
  });

  it('preserves legacy default behavior for existing direct router consumers', () => {
    expect(createAiRouter({ modules }).route({ intent: 'ambiguous', confidence: 0 }, []).tools)
      .toEqual(['tasks_list', 'users_lookup', 'teams_delete', 'teams_lookup', 'invoice_send', 'invoice_list']);
  });
});
