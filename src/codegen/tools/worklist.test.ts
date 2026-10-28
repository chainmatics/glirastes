import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline } from './pipeline.js';
import { buildDescribeWorklist, buildResolveWorklist, MODEL_PLACEHOLDER, type ResolveWorkItem } from './worklist.js';

afterEach(removeAppFixtures);

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n"
  + "export async function checkMembership(request: Request) {\n  return request.headers.get('x-team') !== null;\n}\n";
const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/lib/session.ts': SESSION,
  'src/lib/api.ts': "export async function archiveTask(id: string) {\n  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
  'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'declare function save(value: unknown): Promise<{ id: string }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await save(body));\n}\n',
  'src/app/api/reports/route.ts': "import { checkMembership } from '@/lib/session';\n"
    + 'export async function GET(request: Request) {\n  await checkMembership(request);\n  return Response.json({ reports: [] as string[] });\n}\n',
  'src/components/tasks.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from '@/lib/api';\n"
    + 'export function Tasks() {\n'
    + "  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n"
    + '  return null;\n}\n',
};

async function app(): Promise<AppFixture> {
  return createAppFixture(FILES, { toolsConfig: { sources: ['next-app', 'react-actions'] } });
}

const byCode = (items: ReadonlyArray<ResolveWorkItem>) => new Map(items.map((item) => [`${item.code} ${item.tool}`, item] as const));

describe('tools resolve work list', () => {
  it('lists what stage 1 could not decide, with evidence, target file and entry format', async () => {
    const fixture = await app();
    const list = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(list).toMatchObject({ schemaVersion: 1, kind: 'resolve', outputsCurrent: false, blocking: [] });
    const items = byCode(list.items);
    expect([...items.keys()]).toEqual([
      'input-contract-unresolved notes.create',
      'auth-evidence-missing reports.list',
      'ui-action-write-unproven ui.tasks.archive',
    ]);
    const notes = items.get('input-contract-unresolved notes.create')!;
    expect(notes).toMatchObject({
      stableKey: 'POST /api/notes',
      severity: 'needs_attention',
      owner: 'agent',
      files: ['src/app/api/notes/route.ts', 'src/lib/session.ts'],
      evidence: { route: 'POST /api/notes', params: { path: [], query: [], body: 'opaque' }, riskClass: 'write', enabled: false },
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'tools["POST /api/notes"]' },
      expected: {
        origin: 'agent',
        model: MODEL_PLACEHOLDER,
        interfaceDigest: notes.evidence?.interfaceDigest,
        input: { jsonSchema: { type: 'object', properties: {}, additionalProperties: false } },
      },
    });
    expect(notes.evidence?.interfaceDigest).toMatch(/^sha256:/);
    expect(items.get('auth-evidence-missing reports.list')).toMatchObject({
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'conventions.authHelpers' },
    });
    expect(items.get('ui-action-write-unproven ui.tasks.archive')).toMatchObject({
      owner: 'developer',
      target: { kind: 'developer', command: 'glirastes tools policy raise ui.tasks.archive write' },
    });
  }, 120_000);

  it('is stable and empties once the agent and the developer answered every item', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const first = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    const again = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(first.outputsCurrent).toBe(true);
    const notes = first.items.find((item) => item.tool === 'notes.create')!;
    await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
      schemaVersion: 1,
      conventions: { authHelpers: ['checkMembership'] },
      tools: {
        'POST /api/notes': {
          origin: 'agent',
          model: 'claude-code',
          interfaceDigest: notes.evidence!.interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false } },
        },
      },
    }, null, 2)}\n`);
    await fixture.write(TOOLS_PATHS.policy, `${JSON.stringify({
      schemaVersion: 1, tools: { 'UI action tasks.archive': { riskClass: 'write', reason: 'archives through the API' } },
    })}\n`);
    const refreshed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(buildResolveWorklist(refreshed).items).toEqual([]);
    expect(refreshed.tools?.find((tool) => tool.definitionId === 'notes.create')).toMatchObject({
      enabled: true, schemaQuality: 'agent', contract: { source: 'resolution' },
    });
    expect(refreshed.tools?.find((tool) => tool.definitionId === 'ui.tasks.archive')).toMatchObject({
      riskClass: 'write', requiresApproval: true,
    });
  }, 180_000);

  it('names whole-refresh errors as blocking instead of listing tools', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/broken/route.ts', "export * from './handlers';\n");
    const list = buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }));
    expect(list.blocking.map((finding) => finding.code)).toEqual(['E-INVENTORY-011']);
    expect(list.items).toEqual([]);
    expect(list.outputsCurrent).toBe(false);
  }, 120_000);

  it('lists code and entries stage 1 had to leave out, with the file and the entry to fix', async () => {
    const fixture = await createAppFixture({
      ...FILES,
      'src/components/dynamic.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + 'export function Dynamic({ actionId }: { actionId: string }) {\n'
        + '  useAiClientAction(actionId, () => undefined);\n  return null;\n}\n',
    }, { toolsConfig: { sources: ['next-app', 'react-actions'] } });
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/reports', description: 'Lists reports.', synonyms: { en: ['sk-or-v1 reports'] } },
        { stableKey: 'POST /api/notes', description: 'Saves a note.', mood: 'happy' },
      ],
    })}\n`);
    const items = byCode(buildResolveWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true })).items);
    expect(items.get('ui-action-id-dynamic src/components/dynamic.tsx:4')).toMatchObject({
      owner: 'agent', toolId: null, target: { kind: 'app-code', files: ['src/components/dynamic.tsx'] },
    });
    expect(items.get('tool-semantics-invalid reports.list')).toMatchObject({
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: 'tools[stableKey="GET /api/reports"]' },
    });
    expect(items.get('tool-semantics-invalid .glirastes/tool-semantics.json#1')).toMatchObject({
      owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.semantics, key: '.glirastes/tool-semantics.json#1' },
    });
  }, 120_000);

  it('hands the agent the registration for a UI control without a client action', async () => {
    const fixture = await createAppFixture({
      ...FILES,
      'src/components/density.tsx': "'use client';\nimport { createContext } from 'react';\n"
        + "export const DensityContext = createContext<{ density: 'compact' | 'roomy'; setDensity(density: 'compact' | 'roomy'): void }>"
        + "({ density: 'roomy', setDensity: () => {} });\n",
    }, { toolsConfig: { sources: ['next-app', 'react-actions'] } });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true });
    const items = byCode(buildResolveWorklist(result).items);
    expect(items.get('ui-control-unbound src/components/density.tsx#setDensity')).toMatchObject({
      owner: 'agent',
      toolId: null,
      target: { kind: 'app-code', files: ['src/components/density.tsx'] },
      expected: {
        actionId: 'density.set',
        registration: "useAiClientAction('density.set', ({ density }) => setDensity(density), "
          + "z.object({ density: z.enum(['compact', 'roomy']) }));",
      },
    });
    expect(items.get('ui-control-unbound src/components/density.tsx#setDensity')?.nextAction).toContain('useAiClientAction');
  }, 120_000);
});

const TASKS_ROUTE = "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n"
  + 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
  + 'export async function POST(request: Request) {\n  await getSession(request);\n'
  + '  const input = createTask.parse(await request.json());\n'
  + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n";

async function tasksApp(): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': FILES['tsconfig.json']!,
    'src/lib/session.ts': SESSION,
    'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n",
    'src/app/api/tasks/route.ts': TASKS_ROUTE,
    'src/app/api/notes/route.ts': FILES['src/app/api/notes/route.ts']!,
  }, { toolsConfig: { locale: 'de-DE' } });
}

const describeOptions = (root: string, extra: Partial<Parameters<typeof buildDescribeWorklist>[1]> = {}) => ({
  root, locale: 'de-DE', languages: ['de', 'en'] as Array<'de' | 'en'>, ...extra,
});

describe('tools describe work list', () => {
  it('lists the stage-2 gaps per module with the entries to write and leaves unresolved tools to resolve', async () => {
    const fixture = await tasksApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const list = buildDescribeWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }), describeOptions(fixture.root));
    expect(list).toMatchObject({ kind: 'describe', outputsCurrent: true, languages: ['de', 'en'], writeContracts: false });
    expect(list.modules).toEqual([{ module: 'tasks', tools: ['tasks.create', 'tasks.list'] }]);
    const [create, listTool] = list.items;
    expect(create).toMatchObject({
      tool: 'tasks.create',
      gaps: ['description-templated', 'synonyms-missing', 'examples-missing'],
      protectedFields: [],
      missingExamples: ['de', 'en'],
      targets: { semantics: { file: TOOLS_PATHS.semantics, key: 'tools[stableKey="POST /api/tasks"]' } },
    });
    expect(create?.targets.schema).toBeUndefined();
    expect(create?.targets.semantics.expected).toMatchObject({
      stableKey: 'POST /api/tasks',
      examples: { de: ['<3 to 5 sentences a user would type>'], en: ['<3 to 5 sentences a user would type>'] },
      approvalHint: '<when asking first matters most for this tool>',
      origin: { description: 'agent', examples: 'agent', synonyms: 'agent' },
      agent: { model: MODEL_PLACEHOLDER, interfaceDigest: create?.evidence.interfaceDigest },
    });
    expect(listTool).toMatchObject({
      tool: 'tasks.list',
      gaps: ['description-templated', 'contract-derived', 'synonyms-missing', 'examples-missing'],
      targets: {
        schema: {
          file: TOOLS_PATHS.resolutions,
          key: 'tools["GET /api/tasks"]',
          expected: { origin: 'agent', input: { jsonSchema: { properties: { status: {} }, additionalProperties: false } } },
        },
      },
    });
    expect(listTool?.targets.semantics.expected).not.toHaveProperty('approvalHint');
  }, 180_000);

  it('keeps human fields, writes contract modules on request and drops a tool once it is described', async () => {
    const fixture = await tasksApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const frozen = () => runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true });
    const first = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { tools: ['tasks.list'], writeContracts: true }));
    expect(first.items.map((item) => item.tool)).toEqual(['tasks.list']);
    expect(first.items[0]?.targets.contract?.file).toBe('src/app/api/tasks/contract.ts');
    expect(first.items[0]?.targets.contract?.expected).toContain('  GET: {');
    expect(first.items[0]?.targets.contract?.expected).toContain('"status": z.unknown()');
    const interfaceDigest = first.items[0]!.evidence.interfaceDigest!;
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Listet die Aufgaben des Nutzers, auf Wunsch nach Status gefiltert.',
        synonyms: { de: ['Aufgabenliste', 'offene Aufgaben'], en: ['to-dos'] },
        examples: {
          de: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind erledigt?', 'Liste alle Aufgaben'],
          en: ['list my open tasks', 'which tasks are done', 'show the task list'],
        },
        origin: { synonyms: 'agent', examples: 'agent' },
        agent: { model: 'claude-code', interfaceDigest },
      }],
    }, null, 2)}\n`);
    await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': {
          origin: 'agent',
          model: 'claude-code',
          interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { status: { type: 'array', items: { type: 'string', enum: ['open', 'done'] } } }, additionalProperties: false } },
        },
      },
    }, null, 2)}\n`);
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const after = buildDescribeWorklist(await frozen(), describeOptions(fixture.root));
    expect(after.items.map((item) => item.tool)).toEqual(['tasks.create']);
    const named = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { tools: ['GET /api/tasks'] }));
    expect(named.items[0]).toMatchObject({ gaps: ['requested'], protectedFields: ['description'] });
    expect(named.items[0]?.targets.semantics.expected).not.toHaveProperty('description');
    const all = buildDescribeWorklist(await frozen(), describeOptions(fixture.root, { all: true }));
    expect(all.items.map((item) => item.tool)).toEqual(['tasks.create', 'tasks.list']);
  }, 240_000);

  it('lists a tool whose example sentences do not find it as routing-ambiguous', async () => {
    const fixture = await tasksApp();
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Listet Aufgaben.',
        synonyms: { de: ['Aufgabenliste'] },
        examples: { de: ['Was steht an?', 'Liste alle Aufgaben', 'Aufgabenliste bitte'], en: ['what is up', 'list all tasks', 'task list please'] },
      }],
    })}\n`);
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const list = buildDescribeWorklist(await runToolsPipeline({ root: fixture.root, mode: 'frozen', keepGoing: true }), describeOptions(fixture.root));
    const item = list.items.find((entry) => entry.tool === 'tasks.list');
    expect(item?.gaps).toContain('routing-ambiguous');
    expect(item?.routing.map((failure) => failure.sentence)).toEqual(['Was steht an?', 'what is up']);
  }, 180_000);
});
