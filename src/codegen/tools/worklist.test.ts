import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline } from './pipeline.js';
import { buildResolveWorklist, MODEL_PLACEHOLDER, type ResolveWorkItem } from './worklist.js';

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
});
