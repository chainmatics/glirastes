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

  it('reads a literal route of a page-bound client action into its UI action', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/app/templates/page.tsx': "'use client';\nimport { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + "const TEMPLATES = '/templates' as const;\n"
        + 'export default function Page() {\n'
        + "  useAiClientAction('template-create-dialog.open', () => {}, z.object({}), { route: '/templates' });\n"
        + "  useAiClientAction('templates.refresh', () => {}, z.object({}), { route: TEMPLATES });\n"
        + "  useAiClientAction('templates.select', (payload: { id: string }) => {});\n"
        + '  return null;\n}\n',
      'src/lib/actions.ts': "import { registerAiClientAction } from 'glirastes/browser';\n"
        + "registerAiClientAction('reports.open', (payload: { id: string }) => {}, undefined, { route: '/reports' });\n",
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    expect(tools.get('ui.templateCreateDialog.open')).toMatchObject({
      contract: { uiAction: { kind: 'client-action', actionId: 'template-create-dialog.open', route: '/templates' } },
      findings: [],
    });
    expect(tools.get('ui.templates.refresh')?.contract?.uiAction).toEqual({ kind: 'client-action', actionId: 'templates.refresh', route: '/templates' });
    expect(tools.get('ui.reports.open')?.contract?.uiAction).toEqual({ kind: 'client-action', actionId: 'reports.open', route: '/reports' });
    // Without a route the UI action keeps its earlier shape, so its interface digest does not change.
    expect(tools.get('ui.templates.select')?.contract?.uiAction).toEqual({ kind: 'client-action', actionId: 'templates.select' });
  }, 120_000);

  it('needs attention for an unreadable or invalid route and for routes that disagree', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + 'declare const path: string;\n'
        + 'export function A() {\n'
        + "  useAiClientAction('a.dynamic', (payload: { id: string }) => {}, undefined, { route: path });\n"
        + "  useAiClientAction('a.param', (payload: { id: string }) => {}, undefined, { route: '/tasks/:id' });\n"
        + "  useAiClientAction('a.query', (payload: { id: string }) => {}, undefined, { route: '/tasks?x=1' });\n"
        + "  useAiClientAction('a.external', (payload: { id: string }) => {}, undefined, { route: 'https://example.com' });\n"
        + "  useAiClientAction('a.split', (payload: { id: string }) => {}, undefined, { route: '/one' });\n"
        + "  useAiClientAction('a.mixed', (payload: { id: string }) => {}, undefined, { route: '/one' });\n"
        + '  return null;\n}\n',
      'src/b.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + 'export function B() {\n'
        + "  useAiClientAction('a.split', (payload: { id: string }) => {}, undefined, { route: '/two' });\n"
        + "  useAiClientAction('a.mixed', (payload: { id: string }) => {});\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const codes = (name: string) => tools.get(name)?.findings.map((finding) => [finding.code, finding.severity]);
    for (const name of ['ui.a.dynamic', 'ui.a.param', 'ui.a.query', 'ui.a.external']) {
      expect(codes(name)).toEqual([['ui-action-route-invalid', 'needs_attention']]);
      expect(tools.get(name)?.contract?.uiAction).not.toHaveProperty('route');
    }
    expect(tools.get('ui.a.dynamic')?.findings[0]?.message).toContain('route is not a string literal');
    expect(codes('ui.a.split')).toEqual([['ui-action-route-conflict', 'needs_attention']]);
    expect(tools.get('ui.a.split')?.findings[0]?.message).toBe('a.split is registered with different routes: /one, /two.');
    expect(codes('ui.a.mixed')).toEqual([['ui-action-route-conflict', 'needs_attention']]);
    expect(tools.get('ui.a.split')?.contract?.uiAction).not.toHaveProperty('route');
  }, 120_000);

  it('warns about a handler that only relays a window event and has no route', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/shell.tsx': "import { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + 'export function Shell() {\n'
        + "  useAiClientAction('template-create-dialog.open', () => {\n"
        + "    window.dispatchEvent(new CustomEvent('open-template-create'));\n  }, z.object({}));\n"
        + "  useAiClientAction('a.arrow', () => dispatchEvent(new Event('x')), z.object({}));\n"
        + "  useAiClientAction('a.routed', () => { window.dispatchEvent(new CustomEvent('x')); }, z.object({}), { route: '/a' });\n"
        + "  useAiClientAction('a.mixed', () => { window.dispatchEvent(new CustomEvent('x')); console.log('x'); }, z.object({}));\n"
        + "  useAiClientAction('a.empty', () => {}, z.object({}));\n"
        + '  return null;\n}\n',
    });
    const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
    const indirect = (name: string) => tools.get(name)?.findings.find((finding) => finding.code === 'ui-action-indirect');
    expect(indirect('ui.templateCreateDialog.open')).toMatchObject({
      severity: 'warning',
      subjectRef: 'UI action template-create-dialog.open',
      message: 'template-create-dialog.open only dispatches a window event, so it works only where a listener for that event is mounted.',
    });
    expect(indirect('ui.templateCreateDialog.open')?.nextAction).toContain('route');
    expect(indirect('ui.a.arrow')).toBeDefined();
    expect(indirect('ui.a.routed')).toBeUndefined();
    expect(indirect('ui.a.mixed')).toBeUndefined();
    expect(indirect('ui.a.empty')).toBeUndefined();
  }, 120_000);

  describe('in a monorepo whose path aliases live in the app tsconfig', () => {
    const MONOREPO: Record<string, string> = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'apps/web/tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@contracts/*': ['src/contracts/*'] } },
      }),
      'apps/web/src/contracts/ui.ts': "import { z } from 'zod';\n"
        + 'export const openEntity = z.object({ entityId: z.string() }).strict();\n'
        + 'export interface PinPayload { entityId: string; pinned: boolean }\n',
      'apps/web/src/panel.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
        + "import { openEntity } from '@contracts/ui';\nimport type { PinPayload } from '@contracts/ui';\n"
        + 'export function Panel() {\n'
        + "  useAiClientAction('entity.open', (payload) => console.log(payload), openEntity);\n"
        + "  useAiClientAction('entity.pin', (payload: PinPayload) => console.log(payload));\n"
        + '  return null;\n}\n',
    };
    const inputs = (observations: ObservedTool[]) => Object.fromEntries(
      observations.map((tool) => [tool.execution.definitionId, tool.contract?.input]),
    );

    it('types the payload through the tsconfig nearest to srcDir', async () => {
      const app = await createAppFixture(MONOREPO);
      const observed = await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root));
      expect(inputs(observed.observations)).toEqual({
        'ui.entity.open': object({ entityId: { type: 'string' } }, ['entityId']),
        'ui.entity.pin': object({ entityId: { type: 'string' }, pinned: { type: 'boolean' } }, ['entityId', 'pinned']),
      });
      expect(observed.observations.flatMap((tool) => tool.findings)).toEqual([]);
    }, 120_000);

    it('takes the tsconfig named in tools.json', async () => {
      const app = await createAppFixture({
        ...MONOREPO,
        'apps/web/tsconfig.app.json': MONOREPO['apps/web/tsconfig.json']!,
        'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      });
      const observed = await createReactActionSource({ srcDir: 'apps/web/src', tsconfig: 'apps/web/tsconfig.app.json' })
        .observe(context(app.root));
      expect(observed.observations.flatMap((tool) => tool.findings)).toEqual([]);
    }, 120_000);

    it('says which import could not be resolved and with which tsconfig, instead of calling the payload untyped', async () => {
      const app = await createAppFixture({ ...MONOREPO, 'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }) });
      const observed = await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root));
      const findings = Object.fromEntries(observed.observations.map((tool) => [tool.execution.definitionId, tool.findings]));
      for (const id of ['ui.entity.open', 'ui.entity.pin']) {
        expect(findings[id]).toEqual([expect.objectContaining({ code: 'ui-action-import-unresolved', severity: 'needs_attention' })]);
        expect(findings[id]![0]!.message).toContain('"@contracts/ui"');
        expect(findings[id]![0]!.message).toContain('apps/web/tsconfig.json');
      }
      expect(observed.observations.every((tool) => tool.contract === undefined)).toBe(true);
    }, 120_000);

    it('names the TypeScript defaults when the app has no tsconfig', async () => {
      const { 'tsconfig.json': _root, 'apps/web/tsconfig.json': _web, ...withoutTsconfig } = MONOREPO;
      const app = await createAppFixture(withoutTsconfig);
      const [open] = (await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root))).observations;
      expect(open?.findings).toEqual([expect.objectContaining({ code: 'ui-action-import-unresolved' })]);
      expect(open?.findings[0]!.message).toContain('no tsconfig');
    }, 120_000);
  });

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
