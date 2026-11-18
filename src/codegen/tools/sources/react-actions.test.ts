import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createJsonSchemaLike } from '../../../runtime/json-schema.js';
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
      // The contract lives in a component module the probe cannot import here: typed from TypeScript, as before.
      findings: [expect.objectContaining({ code: 'ui-action-contract-unprobed', severity: 'warning' })],
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

    it('keeps ui-action-payload-untyped when only the handler body uses an unresolved import', async () => {
      const app = await createAppFixture({
        ...MONOREPO,
        'apps/web/src/panel.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
          + "import { logger } from '@missing/logger';\n"
          + "export function Panel() {\n  useAiClientAction('entity.log', (payload) => logger(payload));\n  return null;\n}\n",
      });
      const [log] = (await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root))).observations;
      expect(log?.findings).toEqual([expect.objectContaining({ code: 'ui-action-payload-untyped' })]);
    }, 120_000);

    it('reports an imported handler whose module cannot be resolved', async () => {
      const app = await createAppFixture({
        ...MONOREPO,
        'apps/web/src/panel.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
          + "import { openEntity } from '@missing/handlers';\n"
          + "export function Panel() {\n  useAiClientAction('entity.open', openEntity);\n  return null;\n}\n",
      });
      const [open] = (await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root))).observations;
      expect(open?.findings).toEqual([expect.objectContaining({ code: 'ui-action-import-unresolved' })]);
      expect(open?.findings[0]!.message).toContain('"@missing/handlers"');
    }, 120_000);

    it('hands the probe of a zod contract the tsconfig nearest to srcDir', async () => {
      const app = await createAppFixture(MONOREPO);
      const probe = vi.fn(async (_root: string, items: ReadonlyArray<unknown>) => items.map(() => ({
        ok: false as const,
        reason: 'probe-failed',
      })));
      await createReactActionSource({ srcDir: 'apps/web/src' }).observe({ ...context(app.root), probe: { probe } });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]![2]).toEqual({ tsconfig: join(app.root, 'apps/web/tsconfig.json') });
    }, 120_000);

    it('names the TypeScript defaults when the app has no tsconfig', async () => {
      const { 'tsconfig.json': _root, 'apps/web/tsconfig.json': _web, ...withoutTsconfig } = MONOREPO;
      const app = await createAppFixture(withoutTsconfig);
      const [open] = (await createReactActionSource({ srcDir: 'apps/web/src' }).observe(context(app.root))).observations;
      expect(open?.findings).toEqual([expect.objectContaining({ code: 'ui-action-import-unresolved' })]);
      expect(open?.findings[0]!.message).toContain('no tsconfig');
    }, 120_000);
  });

  describe('zod payload contracts', () => {
    const findingsOf = (tool: ObservedTool | undefined, code: string) => (tool?.findings ?? [])
      .filter((finding) => finding.code === code);

    it('derives formats, descriptions, enums and bounds from an exported zod contract, input side', async () => {
      const app = await createAppFixture({
        'tsconfig.json': TSCONFIG,
        'src/lib/contracts.ts': "import { z } from 'zod';\n"
          + 'export const openEntity = z.object({\n'
          + "  entityId: z.string().uuid().describe('Id of the entity, never its name'),\n"
          + "  kind: z.enum(['task', 'note']),\n"
          + '  limit: z.number().int().min(1).max(50).optional(),\n'
          + "  mode: z.string().default('view'),\n"
          + '  count: z.string().transform(Number),\n'
          + '  page: z.coerce.number().int().min(1).optional(),\n'
          + "}).describe('Open an entity');\n"
          + 'export const contracts = { pick: z.object({ id: z.number().int().positive() }) };\n',
        'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
          + "import { contracts, openEntity } from './lib/contracts';\n"
          + 'export function A() {\n'
          + "  useAiClientAction('entity.open', (payload) => console.log(payload), openEntity);\n"
          + "  useAiClientAction('rows.pick', (payload) => console.log(payload.id), contracts.pick);\n"
          + '  return null;\n}\n',
      });
      const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
      const open = tools.get('ui.entity.open');
      expect(open?.findings).toEqual([]);
      expect(open?.contract?.input).toEqual({
        type: 'object',
        description: 'Open an entity',
        properties: {
          count: { type: 'string' },
          entityId: expect.objectContaining({ type: 'string', format: 'uuid', description: 'Id of the entity, never its name' }),
          kind: { type: 'string', enum: ['task', 'note'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          mode: { type: 'string', default: 'view' },
          page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
        required: ['entityId', 'kind', 'count'],
        additionalProperties: false,
      });
      expect(open?.contract?.runtime.input).toEqual({ kind: 'json', schema: open?.contract?.input });
      expect(open?.prose?.schemaDescription).toBe('Open an entity');
      // The runtime validates the generated JSON Schema with formats: a name instead of a UUID is rejected.
      const validator = createJsonSchemaLike(open!.contract!.input);
      const rejected = validator.safeParse({ entityId: 'Quarterly report', kind: 'task', count: '1' });
      expect(rejected.success).toBe(false);
      expect(rejected.success ? [] : rejected.error.issues.map((issue) => (issue as { keyword?: string }).keyword))
        .toContain('format');
      expect(validator.safeParse({ entityId: '0198c0de-1111-7000-8000-000000000001', kind: 'task', count: '1' }).success)
        .toBe(true);
      // Numeric ids keep their integer type and bounds.
      expect(tools.get('ui.rows.pick')).toMatchObject({
        findings: [],
        contract: { input: { type: 'object', properties: { id: { type: 'integer', exclusiveMinimum: 0 } }, required: ['id'] } },
      });
    }, 120_000);

    it('warns when the zod contract contradicts its TypeScript type and follows the zod contract', async () => {
      const app = await createAppFixture({
        'tsconfig.json': TSCONFIG,
        'src/lib/contracts.ts': "import { z } from 'zod';\n"
          + 'export const pick = z.object({ id: z.string() }) as unknown as z.ZodType<{ id: number }, { id: number }>;\n',
        'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\nimport { pick } from './lib/contracts';\n"
          + "export function A() { useAiClientAction('rows.pick', (payload) => console.log(payload), pick); return null; }\n",
      });
      const tool = byName((await createReactActionSource().observe(context(app.root))).observations).get('ui.rows.pick');
      expect(findingsOf(tool, 'ui-action-contract-mismatch')).toEqual([expect.objectContaining({
        severity: 'warning',
        subjectRef: 'UI action rows.pick',
        message: expect.stringContaining('id'),
      })]);
      expect(tool?.contract?.input).toEqual(object({ id: { type: 'string' } }, ['id']));
    }, 120_000);

    it('falls back to the TypeScript input type when the zod contract cannot be probed', async () => {
      const app = await createAppFixture({
        'tsconfig.json': TSCONFIG,
        'src/lib/v3.ts': "import { z } from 'zod-v3';\nexport const search = z.object({ q: z.string().uuid(), page: z.number().default(1) });\n",
        'src/lib/broken.ts': "import { z } from 'zod';\nthrow new Error('no import-time side effects allowed');\n"
          + 'export const broken = z.object({ id: z.string().uuid() });\n',
        'src/a.tsx': "import { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
          + "import { search } from './lib/v3';\nimport { broken } from './lib/broken';\n"
          + 'export function A() {\n'
          + "  useAiClientAction('rows.search', (payload) => console.log(payload), search);\n"
          + "  useAiClientAction('rows.broken', (payload) => console.log(payload), broken);\n"
          + "  useAiClientAction('rows.inline', (payload) => console.log(payload), z.object({ id: z.string().uuid(), tag: z.string().default('') }));\n"
          + "  useAiClientAction('rows.empty', () => {}, z.object({}));\n"
          + "  useAiClientAction('rows.sort', (payload) => console.log(payload), z.object({ by: z.enum(['name', 'date']).optional() }).strict());\n"
          + '  return null;\n}\n',
      });
      const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
      for (const [name, reason] of [
        ['ui.rows.broken', 'import-failed'],
        ['ui.rows.inline', 'export'],
      ] as const) {
        const tool = tools.get(name);
        expect(findingsOf(tool, 'ui-action-contract-unprobed')).toEqual([expect.objectContaining({
          severity: 'warning', message: expect.stringContaining(reason),
        })]);
        // The tool stays as before: typed from the TypeScript type, never disabled.
        expect(tool?.findings.every((finding) => finding.severity === 'warning')).toBe(true);
      }
      // zod v3 is probed where the app can convert it (zod-to-json-schema); either way the input side counts.
      const search = tools.get('ui.rows.search');
      const searchUnprobed = findingsOf(search, 'ui-action-contract-unprobed');
      if (searchUnprobed.length > 0) {
        expect(searchUnprobed[0]?.message).toContain('JSON Schema');
        expect(search?.contract?.input).toEqual(object({ page: { type: 'number' }, q: { type: 'string' } }, ['q']));
      } else {
        expect(search?.findings).toEqual([]);
        expect(search?.contract?.input).toMatchObject({ properties: { q: { format: 'uuid' } }, required: ['q'] });
      }
      // Input side of the TypeScript type: a field with a default is optional for the model.
      expect(tools.get('ui.rows.inline')?.contract?.input)
        .toEqual(object({ id: { type: 'string' }, tag: { type: 'string' } }, ['id']));
      // Nothing to lose: an empty contract, or an inline one the TypeScript type fully describes.
      expect(tools.get('ui.rows.empty')).toMatchObject({ findings: [], contract: { input: object({}) } });
      expect(tools.get('ui.rows.sort')).toMatchObject({
        findings: [], contract: { input: object({ by: { type: 'string', enum: ['date', 'name'] } }) },
      });
    }, 120_000);

    it('keeps the TypeScript schema when the probe returns no JSON Schema or one the runtime cannot compile', async () => {
      const app = await createAppFixture({
        'tsconfig.json': TSCONFIG,
        'src/lib/contracts.ts': "import { z } from 'zod';\nexport const a = z.object({ q: z.string() });\n"
          + 'export const b = z.object({ q: z.string() });\n',
        'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\nimport { a, b } from './lib/contracts';\n"
          + 'export function A() {\n'
          + "  useAiClientAction('rows.a', (payload) => console.log(payload), a);\n"
          + "  useAiClientAction('rows.b', (payload) => console.log(payload), b);\n"
          + '  return null;\n}\n',
      });
      const probe = vi.fn(async (_root: string, items: ReadonlyArray<{ export: string }>) => items.map((item) => ({
        ok: true as const,
        kind: 'schema' as const,
        digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        jsonSchema: item.export === 'a' ? null : { type: 'object', properties: { q: { type: 'string', pattern: '(' } } },
        description: null,
      })));
      const tools = byName((await createReactActionSource().observe({ ...context(app.root), probe: { probe } })).observations);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(findingsOf(tools.get('ui.rows.a'), 'ui-action-contract-unprobed')[0]?.message).toContain('no JSON Schema');
      expect(findingsOf(tools.get('ui.rows.b'), 'ui-action-contract-unprobed')[0]?.message).toContain('cannot compile');
      for (const name of ['ui.rows.a', 'ui.rows.b']) {
        expect(tools.get(name)?.contract?.input).toEqual(object({ q: { type: 'string' } }, ['q']));
      }
    }, 120_000);

    it('probes a contract imported through a path alias and leaves one outside the app as before', async () => {
      const app = await createAppFixture({
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
        'src/contracts/open.ts': "import { z } from 'zod';\nexport const open = z.object({ id: z.string().uuid() });\n",
        'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\nimport { open } from '@/contracts/open';\n"
          + "export function A() { useAiClientAction('rows.open', (payload) => console.log(payload), open); return null; }\n",
      });
      await app.write('../' + `${app.root.split('/').at(-1)}-shared/contract.ts`,
        "import { z } from 'zod';\nexport const shared = z.object({ id: z.string().uuid() });\n");
      await app.write('src/b.tsx', "import { useAiClientAction } from 'glirastes/react';\n"
        + `import { shared } from '../../${app.root.split('/').at(-1)}-shared/contract';\n`
        + "export function B() { useAiClientAction('rows.shared', (payload) => console.log(payload), shared); return null; }\n");
      try {
        const tools = byName((await createReactActionSource().observe(context(app.root))).observations);
        expect(tools.get('ui.rows.open')).toMatchObject({
          findings: [],
          contract: { input: { properties: { id: { type: 'string', format: 'uuid' } } } },
        });
        expect(findingsOf(tools.get('ui.rows.shared'), 'ui-action-contract-unprobed')).toHaveLength(1);
        expect(tools.get('ui.rows.shared')?.contract?.input).toEqual(object({ id: { type: 'string' } }, ['id']));
      } finally {
        await app.remove(`../${app.root.split('/').at(-1)}-shared`);
      }
    }, 120_000);

    it('never probes an app without zod contracts', async () => {
      const app = await createAppFixture({
        'tsconfig.json': TSCONFIG,
        'src/a.tsx': "import { useAiClientAction } from 'glirastes/react';\n"
          + "export function A() { useAiClientAction('rows.pick', (payload: { id: number }) => console.log(payload.id)); return null; }\n",
      });
      const probe = vi.fn(async () => []);
      const observed = await createReactActionSource().observe({ ...context(app.root), probe: { probe } });
      expect(probe).not.toHaveBeenCalled();
      expect(observed.observations[0]).toMatchObject({
        findings: [],
        contract: { input: object({ id: { type: 'number' } }, ['id']) },
      });
      expect(observed.observations[0]).not.toHaveProperty('prose');
    }, 120_000);
  });

  it('produces nothing without registrations', async () => {
    const app = await createAppFixture({ 'src/a.ts': 'export const x = 1;\n' });
    expect(await createReactActionSource().observe(context(app.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
