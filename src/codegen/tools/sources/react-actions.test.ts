import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createReactActionSource } from './react-actions.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' } });
const TASK_LIST = "'use client';\nimport { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
  + 'export const highlightTask = z.object({ taskId: z.string() }).strict();\n'
  + 'export function TaskList() {\n'
  + '  /** Highlights a task in the visible list. */\n'
  + "  useAiClientAction('tasks.highlight', (payload) => { console.log(payload); }, highlightTask);\n"
  + "  useAiClientAction('dialogs.close', () => {});\n"
  + "  useAiClientAction('tasks.archive', async (payload: { taskId: string; reason?: string }) => {\n"
  + "    await fetch(`/api/tasks/${payload.taskId}/archive`, { method: 'POST' });\n  });\n"
  + "  useAiClientAction('tasks.select', (payload) => console.log(payload));\n"
  + "  const id = 'dynamic';\n  useAiClientAction(id, () => {});\n  return null;\n}\n";
const BROWSER = "import { registerAiClientAction, UiActionBus } from 'glirastes/browser';\n"
  + 'const bus = new UiActionBus();\n'
  + 'export function openDetails(payload: { taskId: string }) { console.log(payload.taskId); }\n'
  + "registerAiClientAction('task-details.open', openDetails);\n"
  + "bus.subscribeById('reports.export', (action: { payload: { format: 'csv' | 'pdf' } }) => console.log(action));\n"
  + "bus.subscribeById('glirastes.navigate', () => {});\n";

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

const byName = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.definitionId, observation] as const),
);
const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false,
});

describe('react-actions source', () => {
  it('turns every literal client action into a tool typed by its contract or handler', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/task-list.tsx': TASK_LIST,
      'src/lib/browser-actions.ts': BROWSER,
    });
    const observed = await createReactActionSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    const tools = byName(observed.observations);
    expect([...tools.keys()]).toEqual([
      'ui.dialogs.close', 'ui.reports.export', 'ui.taskDetails.open', 'ui.tasks.archive', 'ui.tasks.highlight', 'ui.tasks.select',
    ]);
    expect(tools.get('ui.tasks.highlight')).toMatchObject({
      execution: { stableKey: 'UI action tasks.highlight', executionKind: 'ui', actionBindingRef: 'tasks.highlight' },
      contract: {
        source: 'ui-bridge',
        input: object({ taskId: { type: 'string' } }, ['taskId']),
        uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
        params: { path: [], query: [], body: ['taskId'] },
      },
      evidence: { jsDoc: 'Highlights a task in the visible list.' },
      findings: [],
    });
    expect(tools.get('ui.dialogs.close')?.contract?.input).toEqual(object({}));
    expect(tools.get('ui.tasks.archive')).toMatchObject({
      contract: { input: object({ reason: { type: 'string' }, taskId: { type: 'string' } }, ['taskId']) },
      evidence: { uiMutation: true },
    });
    expect(tools.get('ui.taskDetails.open')?.contract?.input).toEqual(object({ taskId: { type: 'string' } }, ['taskId']));
    expect(tools.get('ui.reports.export')?.contract?.input)
      .toEqual(object({ format: { type: 'string', enum: ['csv', 'pdf'] } }, ['format']));
    expect(tools.get('ui.tasks.select')).toMatchObject({
      findings: [expect.objectContaining({ code: 'ui-action-payload-untyped', severity: 'needs_attention' })],
    });
    expect(tools.get('ui.tasks.select')?.contract).toBeUndefined();
    expect(observed.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['ui-action-id-dynamic', 'src/components/task-list.tsx:14'],
      ['ui-action-id-reserved', 'src/lib/browser-actions.ts:6'],
    ]);
  }, 120_000);

  it('needs attention when one action is registered with two payload contracts', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "export function A() { useAiClientAction('tasks.pick', (payload: { taskId: string }) => {}); return null; }\n",
      'src/b.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "export function B() { useAiClientAction('tasks.pick', (payload: { id: number }) => {}); return null; }\n",
    });
    const [tool] = (await createReactActionSource().observe(context(app.root))).observations;
    expect(tool?.findings).toEqual([expect.objectContaining({ code: 'ui-action-contract-conflict', severity: 'needs_attention' })]);
  }, 120_000);

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
