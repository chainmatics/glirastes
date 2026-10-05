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

  describe('request flow in write handlers', () => {
    const route = 'src/app/api/things/route.ts';
    const lib = {
      'src/lib/handle.ts': 'export function handle(...args: unknown[]): unknown { return args; }\n'
        + 'export class Wrapper { constructor(public request: Request) {} }\n',
      'src/lib/auth.ts': 'export async function getSession(...args: unknown[]): Promise<unknown> { return args; }\n'
        + 'export async function requireUser(...args: unknown[]): Promise<unknown> { return args; }\n',
    };
    const analyzeStatements = (
      method: EndpointMethod,
      statements: string,
      conventions: HandlerConventions = NO_CONVENTIONS,
    ) => analyze({
      ...lib,
      [route]: "import { handle, Wrapper } from '../../../lib/handle';\n"
        + "import { getSession, requireUser } from '../../../lib/auth';\n"
        + `export async function ${method}(request: Request) {\n  ${statements}\n`
        + '  return Response.json({ ok: true });\n}\n',
    }, route, method, conventions);

    it.each([
      ['a bare request argument', 'handle(request);'],
      ['a request in a shorthand property', 'handle({ request });'],
      ['a request in a renamed property', 'handle({ req: request });'],
      ['a request in an array', 'handle([request]);'],
      ['a spread array holding the request', 'handle(...[request]);'],
      ['a closure returning the request', 'handle(() => request);'],
      ['a clone argument', 'handle(request.clone());'],
      ['a cast request argument', 'handle(request as Request);'],
      ['a request argument to a constructor', 'new Wrapper(request);'],
      ['an alias variable', 'const r = request;\n  handle(r);'],
      ['a chain of alias variables', 'const a = request;\n  const b = a;\n  handle(b);'],
      ['an alias assigned later', 'let r: Request | undefined;\n  r = request;\n  handle(r);'],
      ['a cloned alias variable', 'const copy = request.clone();\n  handle(copy);'],
      ['a conditional alias', 'const r = request.method ? request : undefined;\n  handle(r);'],
      ['a holder object alias', 'const holder = { request };\n  handle(holder);'],
      ['a body read through a holder object', 'const holder = { request };\n  handle(await holder.request.text());'],
      ['the body stream as an argument', 'handle(request.body);'],
      ['a destructured body stream', 'const { body } = request;\n  handle(body);'],
      ['a text body read', 'handle(await request.text());'],
      ['a form data body read', 'handle(await request.formData());'],
      ['an array buffer body read', 'handle(await request.arrayBuffer());'],
      ['a blob body read', 'handle(await request.blob());'],
      ['a text read through an alias', 'const r = request;\n  handle(await r.text());'],
      ['a request handed to a call inside a closure', 'handle(() => handle(request));'],
    ])('makes the body opaque for %s', async (_label, statements) => {
      const analysis = await analyzeStatements('POST', statements);
      expect(analysis.bodyKeys).toBe('opaque');
      expect(analysis.readsBody).toBe(true);
    });

    it.each(['PUT', 'PATCH'] as const)('makes the body opaque on %s too', async (method) => {
      const analysis = await analyzeStatements(method, 'handle({ request });');
      expect(analysis.bodyKeys).toBe('opaque');
      expect(analysis.readsBody).toBe(true);
    });

    it.each([
      ['a session helper call', 'await getSession(request);'],
      ['a session helper receiving a wrapped request', 'await getSession({ request });'],
      ['a URL built from the request URL', 'const url = new URL(request.url);\n  handle(url.searchParams.get("q"));'],
      ['a header read', 'handle(request.headers.get("authorization"));'],
      ['the headers object', 'handle(request.headers);'],
      ['the method', 'handle(request.method);'],
      ['a header read through an alias', 'const r = request;\n  handle(r.headers.get("x"));'],
      ['destructured headers', 'const { headers } = request;\n  handle(headers);'],
      ['a shadowing parameter in a closure', 'handle((request: string) => handle(request));'],
      ['an unrelated local named like the request', 'const other = { request: 1 };\n  handle(other.request);'],
    ])('keeps an empty derived body for %s', async (_label, statements) => {
      const analysis = await analyzeStatements('POST', statements);
      expect(analysis.bodyKeys).toEqual([]);
      expect(analysis.readsBody).toBe(false);
    });

    it('treats declared auth helpers as non-escaping and other helpers as escaping', async () => {
      const conventions: HandlerConventions = { ...NO_CONVENTIONS, authHelpers: ['requireUser'] };
      const safe = await analyzeStatements('POST', 'await requireUser(request);', conventions);
      expect(safe.bodyKeys).toEqual([]);
      expect(safe.readsBody).toBe(false);
      const unknown = await analyzeStatements('POST', 'await requireUser(request);');
      expect(unknown.bodyKeys).toBe('opaque');
      expect(unknown.readsBody).toBe(true);
    });

    it('does not widen read handlers because the request is handed on', async () => {
      for (const statements of ['handle(request);', 'handle({ request });', 'handle(await request.text());']) {
        for (const method of ['GET', 'DELETE'] as const) {
          const analysis = await analyzeStatements(method, statements);
          expect(analysis.bodyKeys).toEqual([]);
          expect(analysis.readsBody).toBe(false);
        }
      }
    });

    it('follows the request of a wrapped arrow handler and of a plain JavaScript route', async () => {
      const wrapped = 'src/app/api/wrapped/route.ts';
      const wrapper = 'export function withSession(handler: (request: Request) => Promise<Response>) { return handler; }\n';
      const wrappedAnalysis = await analyze({
        ...lib,
        'src/lib/with-session.ts': wrapper,
        [wrapped]: "import { handle } from '../../../lib/handle';\n"
          + "import { withSession } from '../../../lib/with-session';\n"
          + 'export const POST = withSession(async (request) => {\n  handle({ request });\n'
          + '  return Response.json({ ok: true });\n});\n',
      }, wrapped, 'POST');
      expect(wrappedAnalysis.bodyKeys).toBe('opaque');
      expect(wrappedAnalysis.readsBody).toBe(true);
      const plain = 'src/app/api/plain/route.js';
      const plainAnalysis = await analyze({
        ...lib,
        [plain]: "import { handle } from '../../../lib/handle.js';\n"
          + 'export async function POST(request) {\n  const copy = request.clone();\n  handle(copy);\n'
          + '  return Response.json({ ok: true });\n}\n',
      }, plain, 'POST');
      expect(plainAnalysis.bodyKeys).toBe('opaque');
      expect(plainAnalysis.readsBody).toBe(true);
    });

    it('keeps an empty derived body when a declared wrapper owns the request', async () => {
      const wrapperRoute = 'src/app/api/commands/route.ts';
      const analysis = await analyze({
        'src/lib/command.ts': 'export async function command(request: Request, input: unknown): Promise<Response> {\n'
          + '  return Response.json({ input, body: await request.json() });\n}\n',
        'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createCommand = z.object({ name: z.string() });\n",
        [wrapperRoute]: "import { command } from '../../../lib/command';\n"
          + "import { createCommand } from '../../../lib/schemas';\n"
          + 'export async function POST(request: Request) {\n  return command(request, createCommand);\n}\n',
      }, wrapperRoute, 'POST', {
        ...NO_CONVENTIONS, handlerWrappers: [{ module: 'src/lib/command.ts', export: 'command', inputArg: 1 }],
      });
      expect(analysis.schemaUses).toEqual([
        { role: 'body', via: 'wrapper', binding: { module: 'src/lib/schemas.ts', export: 'createCommand', property: [] } },
      ]);
      expect(analysis.bodyKeys).toEqual([]);
      expect(analysis.readsBody).toBe(false);
    });

    it('keeps closed keys when the body is read through the JSON reader', async () => {
      const analysis = await analyzeStatements('POST', 'const { title } = await request.json();\n  handle(title);');
      expect(analysis.bodyKeys).toEqual(['title']);
      expect(analysis.readsBody).toBe(true);
    });
  });

  it('compares convention modules without extensions', () => {
    expect(sameModule('src/query.js', './src/query.ts')).toBe(true);
    expect(sameModule('src/query.js', 'src/app/query.js')).toBe(false);
  });
});
