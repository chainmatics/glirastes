import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { analyzeRouteHandler, sameModule, type HandlerConventions } from './handler-analysis.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const NO_CONVENTIONS: HandlerConventions = { handlerWrappers: [], bodyReaders: [], authHelpers: [] };
const ALIAS_TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
});

async function analyze(
  files: Record<string, string>,
  route: string,
  method: EndpointMethod,
  conventions: HandlerConventions = NO_CONVENTIONS,
) {
  const app = await createAppFixture(files);
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  return analyzeRouteHandler({
    app: program, sourceFile: program.sourceFile(app.path(route))!, method, conventions,
  });
}

describe('analyzeRouteHandler', () => {
  it('binds a native body schema through a path alias and the explicit output schema', async () => {
    const route = 'src/app/api/notes/route.ts';
    const analysis = await analyze({
      'tsconfig.json': ALIAS_TSCONFIG,
      'src/lib/notes.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n'
        + 'export const noteOutput = z.object({ id: z.string(), title: z.string() });\n',
      [route]: "import { createNote, noteOutput } from '@/lib/notes';\n"
        + 'export async function POST(request: Request) {\n'
        + '  const input = createNote.safeParse(await request.json());\n'
        + "  if (!input.success) return Response.json({ error: 'invalid' }, { status: 400 });\n"
        + "  return Response.json(noteOutput.parse({ id: '1', title: input.data.title }), { status: 201 });\n}\n",
    }, route, 'POST');
    expect(analysis.schemaUses).toEqual([
      { role: 'body', via: 'parse', binding: { module: 'src/lib/notes.ts', export: 'createNote', property: [] } },
      { role: 'output', via: 'parse', binding: { module: 'src/lib/notes.ts', export: 'noteOutput', property: [] } },
    ]);
    expect(analysis.responseArguments).toHaveLength(1);
    expect(analysis.importedModules).toEqual(['src/lib/notes.ts']);
    expect(analysis.readsBody).toBe(true);
  });

  it('binds contract-module properties and namespace imports', async () => {
    const route = 'src/app/api/tasks/route.ts';
    const files = {
      'src/app/api/tasks/contract.ts': "import { z } from 'zod';\n"
        + 'export const contract = { POST: { input: z.object({ title: z.string() }) } };\n',
      'src/app/api/tasks/schemas.ts': "import { z } from 'zod';\n"
        + 'export const listQuery = z.object({ q: z.string().optional() });\n',
      [route]: "import { contract } from './contract';\nimport * as schemas from './schemas';\n"
        + 'export async function POST(request: Request) {\n'
        + '  return Response.json(contract.POST.input.parse(await request.json()));\n}\n'
        + 'export async function GET(request: Request) {\n'
        + '  return Response.json(schemas.listQuery.parse(Object.fromEntries(new URL(request.url).searchParams)));\n}\n',
    };
    expect((await analyze(files, route, 'POST')).schemaUses).toEqual([{
      role: 'body', via: 'parse',
      binding: { module: 'src/app/api/tasks/contract.ts', export: 'contract', property: ['POST', 'input'] },
    }]);
    expect((await analyze(files, route, 'GET')).schemaUses).toEqual([{
      role: 'query', via: 'parse',
      binding: { module: 'src/app/api/tasks/schemas.ts', export: 'listQuery', property: [] },
    }]);
  });

  it('reports a schema declared only inside the route as not exported and ignores JSON.parse', async () => {
    const route = 'src/app/api/items/route.ts';
    const analysis = await analyze({
      [route]: "import { z } from 'zod';\nconst local = z.object({ title: z.string() });\n"
        + 'export async function POST(request: Request) {\n'
        + '  const raw = JSON.parse(await request.text());\n'
        + '  const input = local.parse(await request.json());\n'
        + '  return Response.json({ input, raw });\n}\n',
    }, route, 'POST');
    expect(analysis.schemaUses).toEqual([{ role: 'body', via: 'parse', problem: 'not-exported' }]);
  });

  it('applies a declared handler wrapper only for the declared module', async () => {
    const route = 'src/app/api/tasks/route.js';
    const files = {
      'src/query.js': 'export async function query(request, inputSchema, outputSchema, execute) {\n'
        + '  return Response.json(outputSchema.parse(await execute(inputSchema.parse({}))));\n}\n',
      'src/app/api/tasks/contract.js': "import { z } from 'zod';\n"
        + 'export const inputSchema = z.object({ status: z.string().optional() });\n'
        + 'export const outputSchema = z.object({ tasks: z.array(z.string()) });\n',
      [route]: "import { inputSchema, outputSchema } from './contract.js';\n"
        + "import { query } from '../../../query.js';\n"
        + 'export async function GET(request) {\n'
        + '  return query(request, inputSchema, outputSchema, () => ({ tasks: [] }));\n}\n',
    };
    const declared = await analyze(files, route, 'GET', {
      ...NO_CONVENTIONS,
      handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
    });
    expect(declared.schemaUses).toEqual([
      { role: 'query', via: 'wrapper', binding: { module: 'src/app/api/tasks/contract.js', export: 'inputSchema', property: [] } },
      { role: 'output', via: 'wrapper', binding: { module: 'src/app/api/tasks/contract.js', export: 'outputSchema', property: [] } },
    ]);
    const other = await analyze(files, route, 'GET', {
      ...NO_CONVENTIONS,
      handlerWrappers: [{ module: 'src/other.js', export: 'query', queryArg: 1 }],
    });
    expect(other.schemaUses).toEqual([]);
  });

  it('treats declared body readers as body reads and unknown request consumers as opaque bodies', async () => {
    const route = 'src/app/api/tasks/route.ts';
    const files = {
      'src/lib/body.ts': 'export async function readJsonBody(request: Request): Promise<unknown> { return request.json(); }\n',
      'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() });\n",
      'src/lib/session.ts': 'export async function getSession(request: Request) { return request.headers.get("cookie"); }\n',
      [route]: "import { readJsonBody } from '../../../lib/body';\nimport { createTask } from '../../../lib/schemas';\n"
        + "import { getSession } from '../../../lib/session';\n"
        + 'export async function POST(request: Request) {\n'
        + '  await getSession(request);\n'
        + '  const input = createTask.parse(await readJsonBody(request));\n'
        + '  return Response.json(input);\n}\n',
    };
    const declared = await analyze(files, route, 'POST', {
      ...NO_CONVENTIONS, bodyReaders: [{ module: 'src/lib/body.ts', export: 'readJsonBody' }],
    });
    expect(declared.schemaUses).toEqual([
      { role: 'body', via: 'parse', binding: { module: 'src/lib/schemas.ts', export: 'createTask', property: [] } },
    ]);
    expect(declared.bodyKeys).toBe('opaque');
    const undeclared = await analyze(files, route, 'POST');
    expect(undeclared.readsBody).toBe(true);
    expect(undeclared.bodyKeys).toBe('opaque');
    expect(undeclared.schemaUses.some((use) => use.role === 'body')).toBe(false);
  });

  it('compares convention modules without extensions', () => {
    expect(sameModule('src/query.js', './src/query.ts')).toBe(true);
    expect(sameModule('src/query.js', 'src/app/query.js')).toBe(false);
  });
});
