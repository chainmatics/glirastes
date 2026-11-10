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

  it('flags handlers that may write through a helper, a mutation hook or a computed fetch method', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/api.ts': 'export async function archiveTask(id: string) {\n'
        + "  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from './lib/api';\n"
        + 'declare const mutation: { mutate(input: unknown): void };\n'
        + 'export function A() {\n'
        + "  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n"
        + "  useAiClientAction('tasks.star', (payload: { taskId: string }) => mutation.mutate(payload));\n"
        + "  useAiClientAction('tasks.sync', (payload: { method: string }) => fetch('/api/sync', { method: payload.method }));\n"
        + "  useAiClientAction('tasks.peek', (payload: { taskId: string }) => console.log(payload.taskId));\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const unproven = (name: string) => tools.get(name)?.findings
      .find((finding) => finding.code === 'ui-action-write-unproven');
    expect(unproven('ui.tasks.archive')).toMatchObject({
      severity: 'warning',
      subjectRef: 'UI action tasks.archive',
      message: 'tasks.archive calls archiveTask from src/lib/api.ts; if that changes data, raise the tool to write so the chat asks first.',
    });
    expect(unproven('ui.tasks.archive')?.nextAction).toContain('glirastes tools policy raise <tool> write');
    expect(unproven('ui.tasks.star')?.message).toContain('calls mutation.mutate()');
    expect(unproven('ui.tasks.sync')?.message).toContain('calls fetch with a method the generator cannot read');
    expect(unproven('ui.tasks.peek')).toBeUndefined();
    expect(tools.get('ui.tasks.archive')?.evidence.uiMutation).toBeUndefined();
    expect(tools.get('ui.tasks.archive')?.files).toEqual(['src/a.tsx']);
  }, 120_000);

  it('does not flag ordinary method calls on payload fields or shared constants declared in other files', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/types.ts': 'export interface TaskPayload { taskId: string; ids: string[] }\n',
      'src/lib/api.ts': 'const remove = (id: string) => fetch(`/api/tasks/${id}`, { method: \'DELETE\' });\n'
        + 'export async function archiveTask(id: string) { await remove(id); }\n'
        + "export const TASK_LABEL = 'task';\n"
        + 'export const taskApi = { async remove(id: string) { await remove(id); } };\n'
        + 'export class TaskService { static async purge(id: string) { await remove(id); } }\n',
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "import * as api from './lib/api';\nimport { TASK_LABEL, TaskService, taskApi } from './lib/api';\n"
        + "import type { TaskPayload } from './types';\n"
        + 'export function A() {\n'
        + "  useAiClientAction('tasks.shout', (payload: TaskPayload) => console.log(payload.taskId.toUpperCase()));\n"
        + "  useAiClientAction('tasks.ids', (payload: TaskPayload) => payload.ids.map((id) => id.trim()));\n"
        + "  useAiClientAction('tasks.label', () => console.log(TASK_LABEL.toUpperCase()));\n"
        + "  useAiClientAction('tasks.namespace', (payload: TaskPayload) => api.archiveTask(payload.taskId));\n"
        + "  useAiClientAction('tasks.client', (payload: TaskPayload) => taskApi.remove(payload.taskId));\n"
        + "  useAiClientAction('tasks.service', (payload: TaskPayload) => TaskService.purge(payload.taskId));\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const unproven = (name: string) => tools.get(name)?.findings
      .find((finding) => finding.code === 'ui-action-write-unproven');
    expect(tools.size).toBe(6);
    expect(unproven('ui.tasks.shout')).toBeUndefined();
    expect(unproven('ui.tasks.ids')).toBeUndefined();
    expect(unproven('ui.tasks.label')).toBeUndefined();
    expect(unproven('ui.tasks.namespace')?.message).toContain('calls api.archiveTask from src/lib/api.ts');
    expect(unproven('ui.tasks.client')?.message).toContain('calls taskApi.remove from src/lib/api.ts');
    expect(unproven('ui.tasks.service')?.message).toContain('calls TaskService.purge from src/lib/api.ts');
  }, 120_000);

  it('treats a fetch whose method is a shorthand property as unproven and a literal GET as read', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + 'export function A() {\n'
        + "  useAiClientAction('tasks.shorthand', (payload: { method: string }) => {\n"
        + "    const { method } = payload;\n    return fetch('/api/x', { method });\n  });\n"
        + "  useAiClientAction('tasks.read', () => fetch('/api/x', { method: 'GET' }));\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const unproven = (name: string) => tools.get(name)?.findings
      .find((finding) => finding.code === 'ui-action-write-unproven');
    expect(unproven('ui.tasks.shorthand')?.message)
      .toBe('tasks.shorthand calls fetch with a method the generator cannot read; if that changes data, raise the tool to write so the chat asks first.');
    expect(tools.get('ui.tasks.shorthand')?.evidence.uiMutation).toBeUndefined();
    expect(unproven('ui.tasks.read')).toBeUndefined();
  }, 120_000);

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
