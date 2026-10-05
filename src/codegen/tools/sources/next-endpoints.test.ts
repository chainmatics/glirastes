import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createLocalSchemaDigest } from '../../../runtime/local-tool-bindings.js';
import type { SchemaLike } from '../../../types.js';
import { ExecutionGenerationStateSchema } from '../../inventory-generation.js';
import { createRouteSourceFingerprint } from '../../route-scanner.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import { EMPTY_CONVENTIONS, type ToolResolutions } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createNextEndpointSource } from './next-endpoints.js';

afterEach(removeAppFixtures);

const POLICY = ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} });

function context(root: string, overrides: Partial<ToolSourceContext> = {}): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: POLICY,
    previousContracts: new Map(),
    probe: createSchemaProbe(),
    ...overrides,
  };
}

const byKey = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.stableKey, observation] as const),
);

const APP_FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/lib/session.ts': "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n",
  'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n",
  'src/app/api/tasks/route.ts': "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n"
    + "/** Lists the caller's tasks. */\n"
    + 'export async function GET(request: Request) {\n  await getSession(request);\n'
    + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
    + 'export async function POST(request: Request) {\n  await getSession(request);\n'
    + '  const input = createTask.parse(await request.json());\n'
    + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n",
  'src/app/api/tasks/[id]/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'export async function DELETE(request: Request) {\n  await getSession(request);\n  return Response.json({ deleted: true });\n}\n',
  'src/app/api/raw/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'declare function save(value: unknown): Promise<{ ok: boolean }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await save(body));\n}\n',
  'src/app/api/open/route.ts': 'export async function GET() {\n  return Response.json({ open: true });\n}\n',
  'src/lib/logging.ts': 'export function withLogging<T>(handler: T): T {\n  return handler;\n}\n',
  'src/app/api/logged/route.ts': "import { getSession } from '@/lib/session';\nimport { withLogging } from '@/lib/logging';\n"
    + 'export const GET = withLogging(async (request: Request) => {\n  await getSession(request);\n'
    + '  return Response.json({ ok: true });\n});\n',
  'src/app/api/wrapped/route.ts': "import { handlers } from './handlers';\nexport const GET = handlers.GET;\n",
  'src/app/api/wrapped/handlers.ts': 'export const handlers = { GET: async () => Response.json([]) };\n',
  'src/app/api/notes/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
    + "  POST: { input: z.object({ title: z.string() }), description: 'Create a note for the caller', effect: 'write', id: 'notes.add' },\n};\n",
  'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\nimport { contract } from './contract';\n"
    + 'declare function createNote(input: unknown, shape: typeof contract): Promise<{ id: string }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await createNote(body, contract));\n}\n',
  'src/app/api/auth/login/route.ts': 'export async function POST() { return Response.json({}); }\n',
  'src/app/api/chat/route.ts': "import { createAiChatHandler } from 'glirastes/server/nextjs';\n"
    + 'export const POST = createAiChatHandler({} as never);\n',
};

describe('next-app endpoint source', () => {
  it('turns every enumerated route into a tool, an attention item or a reasoned exclusion', async () => {
    const app = await createAppFixture(APP_FILES);
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    expect(observed.excluded).toEqual([
      { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
      { stableKey: 'POST /api/chat', reason: 'chat-handler', origin: 'default' },
    ]);
    const tools = byKey(observed.observations);
    expect(Object.fromEntries([...tools].map(([key, tool]) => [key, tool.execution.definitionId]))).toEqual({
      'DELETE /api/tasks/:id': 'tasks.delete',
      'GET /api/logged': 'logged.list',
      'GET /api/open': 'open.list',
      'GET /api/tasks': 'tasks.list',
      'GET /api/wrapped': 'wrapped.list',
      'POST /api/notes': 'notes.add',
      'POST /api/raw': 'raw.create',
      'POST /api/tasks': 'tasks.create',
    });

    const create = tools.get('POST /api/tasks')!;
    expect(create.execution).toMatchObject({
      executionKind: 'endpoint',
      sourceKind: 'next-app',
      sourceFile: 'src/app/api/tasks/route.ts',
      sourceFingerprint: createRouteSourceFingerprint(await app.read('src/app/api/tasks/route.ts'), 'POST', '/api/tasks'),
    });
    expect(create.contract).toMatchObject({
      source: 'native',
      loadBearing: true,
      params: { path: [], query: [], body: ['title'] },
      runtime: { input: { kind: 'module-export', module: 'src/lib/schemas.ts', export: 'createTask' } },
    });
    expect(create.findings).toEqual([]);
    expect(create.evidence).toEqual({ authEvidence: true, externalCall: false });

    const list = tools.get('GET /api/tasks')!;
    expect(list.contract).toMatchObject({ source: 'derived', params: { query: ['status'] } });
    expect(list.evidence.jsDoc).toBe("Lists the caller's tasks.");
    expect(list.findings.map((finding) => finding.code)).toEqual(['contract-derived']);

    const attention = (key: string) => tools.get(key)!.findings
      .filter((finding) => finding.severity === 'needs_attention')
      .map((finding) => finding.code);
    expect(attention('POST /api/raw')).toEqual(['input-contract-unresolved']);
    expect(attention('GET /api/open')).toEqual(['auth-evidence-missing']);
    expect(attention('GET /api/wrapped')).toEqual(['handler-unresolved']);
    expect(tools.get('GET /api/wrapped')!.execution.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);

    // A wrapper export is enumerated through the route reader's
    // `route-export-unresolved` finding and analysed through its inner function.
    const logged = tools.get('GET /api/logged')!;
    expect(logged.execution.sourceFingerprint)
      .toBe(createRouteSourceFingerprint(await app.read('src/app/api/logged/route.ts'), 'GET', '/api/logged'));
    expect(logged.evidence.authEvidence).toBe(true);
    expect(logged.contract).toMatchObject({ source: 'derived' });
    expect(logged.findings.map((finding) => finding.code)).toEqual(['contract-derived']);

    const notes = tools.get('POST /api/notes')!;
    expect(notes.contract).toMatchObject({ source: 'contract-module', loadBearing: true });
    expect(notes.evidence.declaredEffect).toBe('write');
    expect(notes.prose?.contractDescription).toBe('Create a note for the caller');
  }, 60_000);

  it('reports HEAD and OPTIONS exports as unsupported-method exclusions instead of dropping them', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'declare function getSession(): Promise<unknown>;\n'
        + 'export async function GET() { await getSession(); return Response.json([]); }\n'
        + 'export async function HEAD() { return new Response(null); }\n'
        + 'async function preflight() { return new Response(null); }\n'
        + 'export { preflight as OPTIONS };\n',
      'src/app/api/tasks/[id]/route.ts': 'export const { HEAD } = { HEAD: async () => new Response(null) };\n',
      // A route file that exports nothing else yields no route candidate at all.
      'src/app/api/ping/route.ts': 'export const OPTIONS = async () => new Response(null);\n',
      'src/app/api/auth/login/route.ts': 'export async function POST() { return Response.json({}); }\n'
        + 'export async function OPTIONS() { return new Response(null); }\n',
      // Private folders are not routes; the scanner skips them and so does the export check.
      'src/app/api/_private/route.ts': 'export async function HEAD() { return new Response(null); }\n',
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    expect(observed.observations.map((tool) => tool.execution.stableKey)).toEqual(['GET /api/tasks']);
    expect(observed.excluded).toEqual([
      { stableKey: 'HEAD /api/tasks', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'HEAD /api/tasks/:id', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/auth/login', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/ping', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'OPTIONS /api/tasks', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
    ]);
  }, 60_000);

  it('still reports a route file that only exports unsupported methods', async () => {
    const app = await createAppFixture({
      'src/app/api/ping/route.ts': 'export const OPTIONS = async () => new Response(null);\n',
    });
    expect(await createNextEndpointSource().observe(context(app.root))).toEqual({
      observations: [],
      findings: [],
      complete: true,
      excluded: [{ stableKey: 'OPTIONS /api/ping', reason: 'unsupported-method', origin: 'code' }],
    });
  }, 60_000);

  it('reports export * as incomplete enumeration', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': "export * from './handlers';\n",
      'src/app/api/tasks/handlers.ts': 'export async function GET() { return Response.json([]); }\n',
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(false);
    expect(observed.findings.map((finding) => [finding.code, finding.severity])).toEqual([['E-INVENTORY-011', 'error']]);
  }, 60_000);

  it('applies declared wrapper and auth conventions to the reference fixture', async () => {
    const app = await createAppFixture();
    await cp(join(SDK_ROOT, 'examples/source-driven-next/native'), app.root, { recursive: true });
    const resolutions: ToolResolutions = {
      conventions: {
        ...EMPTY_CONVENTIONS,
        handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
        authHelpers: ['resolveSession'],
      },
      entries: new Map(),
    };
    const observed = await createNextEndpointSource().observe(context(app.root, { resolutions }));
    const contract = await import(pathToFileURL(app.path('src/app/api/tasks/contract.js')).href) as {
      inputSchema: SchemaLike;
      outputSchema: SchemaLike;
    };
    const [tasks] = observed.observations;
    expect(tasks?.execution).toMatchObject({
      stableKey: 'GET /api/tasks',
      definitionId: 'tasks.list',
      inputSchemaDigest: createLocalSchemaDigest(contract.inputSchema),
      outputSchemaDigest: createLocalSchemaDigest(contract.outputSchema),
    });
    expect(tasks?.contract).toMatchObject({
      source: 'native',
      params: { query: ['status'] },
      runtime: {
        input: { kind: 'module-export', module: 'src/app/api/tasks/contract.js', export: 'inputSchema' },
        output: { kind: 'module-export', module: 'src/app/api/tasks/contract.js', export: 'outputSchema' },
      },
    });
    expect(tasks?.findings).toEqual([]);
    expect(tasks?.prose?.schemaDescription).toBe('List your tasks, optionally filtered by status.');
  }, 60_000);

  it('keeps a previous definition id and handles apps without an API directory', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'export async function GET() { await getSession(); return Response.json([]); }\n'
        + 'declare function getSession(): Promise<unknown>;\n',
    });
    const previous = ExecutionGenerationStateSchema.parse({
      schemaVersion: 1,
      appId: FIXTURE_APP_ID,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'tool-fixture',
        executions: [{
          toolId: '019fb007-0000-7000-8000-0000000000d1',
          definitionId: 'tasks.search',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFile: 'src/app/api/tasks/route.ts',
          method: 'GET',
          path: '/api/tasks',
          sourceFingerprint: `sha256:${'F'.repeat(43)}`,
          inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
          outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
        }],
      },
      tombstones: [],
    });
    const observed = await createNextEndpointSource().observe(context(app.root, { previous }));
    expect(observed.observations[0]?.execution.definitionId).toBe('tasks.search');
    const empty = await createAppFixture();
    expect(await createNextEndpointSource().observe(context(empty.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
