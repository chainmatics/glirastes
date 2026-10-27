import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createReactActionSource } from './react-actions.js';
import { createUrlFilterSource } from './url-filters.js';
import { vueScriptOf } from './vue-sfc.js';

afterEach(removeAppFixtures);

const TASKS_VIEW = '<template>\n  <ul><li v-for="task in tasks">{{ task.title }}</li></ul>\n</template>\n\n'
  + '<script setup lang="ts">\n'
  + "import { registerAiClientAction } from 'glirastes/browser';\n"
  + "import { highlightTask } from '../ui-contracts';\n"
  + "registerAiClientAction('tasks.highlight', (payload: { title: string }) => console.log(payload.title), highlightTask);\n"
  + '</script>\n\n<style scoped>\nli { color: red; }\n</style>\n';
const CONTRACTS = "import { z } from 'zod';\nexport const highlightTask = z.object({ title: z.string() }).strict();\n";
const FILTERS_VIEW = '<script lang="ts">\n'
  + "import { defineQueryFilters } from 'glirastes/browser';\n"
  + "export const reportFilters = defineQueryFilters({ path: '/reports', filters: { range: ['week', 'month'] } });\n"
  + '</script>\n<template><p>Reports</p></template>\n';

function context(root: string): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

describe('.vue script blocks', () => {
  it('keeps only the script blocks, at their original offsets and lines', () => {
    const script = vueScriptOf(TASKS_VIEW);

    expect(script.ok).toBe(true);
    const text = (script as { text: string }).text;
    expect(text).toHaveLength(TASKS_VIEW.length);
    expect(text.split('\n')).toHaveLength(TASKS_VIEW.split('\n').length);
    expect(text.indexOf("registerAiClientAction('tasks.highlight'")).toBe(TASKS_VIEW.indexOf("registerAiClientAction('tasks.highlight'"));
    expect(text).not.toContain('template');
    expect(text).not.toContain('color: red');
  });

  it.each([
    ['an external script', '<script src="./view.ts"></script>\n', 'src attribute'],
    ['a tsx block', '<script setup lang="tsx">\nconst a = <p />;\n</script>\n', 'lang="tsx"'],
  ])('refuses %s instead of reading part of it', (_label, text, reason) => {
    const script = vueScriptOf(text);

    expect(script.ok).toBe(false);
    expect((script as { reason: string }).reason).toContain(reason);
  });

  it('reads a client action registered in <script setup>', async () => {
    const app = await createAppFixture({
      'src/views/TasksView.vue': TASKS_VIEW,
      'src/ui-contracts.ts': CONTRACTS,
    }, { toolsConfig: { sources: ['react-actions'] } });
    const observed = await createReactActionSource().observe(context(app.root));

    expect(observed.complete).toBe(true);
    expect(observed.observations.map((tool) => tool.execution.definitionId)).toEqual(['ui.tasks.highlight']);
    const [highlight] = observed.observations;
    expect(highlight!.contract!.input).toMatchObject({ properties: { title: { type: 'string' } }, required: ['title'] });
    expect(highlight!.files).toEqual(['src/views/TasksView.vue']);
  });

  it('reads query filters defined in a .vue script block', async () => {
    const app = await createAppFixture({ 'src/views/ReportsView.vue': FILTERS_VIEW },
      { toolsConfig: { sources: ['url-filters'] } });
    const observed = await createUrlFilterSource().observe(context(app.root));

    expect(observed.complete).toBe(true);
    expect(observed.observations.map((tool) => tool.execution.definitionId)).toEqual(['ui.filter.reports']);
    expect(observed.observations[0]!.contract!.input).toMatchObject({ properties: { range: { enum: ['month', 'week'] } } });
  });

  it('stops with E-INVENTORY-011 when a registration sits in a block it cannot read', async () => {
    const app = await createAppFixture({
      'src/views/TasksView.vue': TASKS_VIEW.replace('lang="ts"', 'lang="tsx"'),
      'src/ui-contracts.ts': CONTRACTS,
    }, { toolsConfig: { sources: ['react-actions'] } });
    const observed = await createReactActionSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011' })]);
    expect(observed.findings[0]!.message).toContain('src/views/TasksView.vue has a <script lang="tsx"> block');
  });
});
