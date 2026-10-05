import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { locateRouteHandler } from './handler-locator.js';
import {
  classifyInputExpression,
  collectBodyKeys,
  collectQueryKeys,
  createRoleContext,
} from './input-roles.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const DEFAULT_SIGNATURE = 'request: Request, { params }: { params: Promise<{ id: string }> }';

async function handler(body: string, options: { bodyReader?: string; signature?: string } = {}) {
  const route = 'src/app/api/things/[id]/route.ts';
  const app = await createAppFixture({
    [route]: "import { readJsonBody } from './reader';\nimport { Schema } from './schema';\n"
      + `export async function POST(${options.signature ?? DEFAULT_SIGNATURE}) {\n${body}\n}\n`,
    'src/app/api/things/[id]/reader.ts': 'export async function readJsonBody(request: Request): Promise<unknown> { return request.json(); }\n',
    'src/app/api/things/[id]/schema.ts': "import { z } from 'zod';\nexport const Schema = z.object({ title: z.string() });\n",
  });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const located = locateRouteHandler(program.sourceFile(app.path(route))!, 'POST')!;
  const ctx = createRoleContext(located, (call) => (
    ts.isIdentifier(call.expression) && call.expression.text === options.bodyReader
  ));
  const parsed: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'parse' && node.arguments[0]) parsed.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(located.fn!.body!);
  return { program, located, ctx, roles: parsed.map((argument) => classifyInputExpression(argument, ctx)) };
}

describe('input roles', () => {
  it.each([
    ['a direct body read', 'return Response.json(Schema.parse(await request.json()));', 'body'],
    ['a body variable', 'const body = await request.json();\nreturn Response.json(Schema.parse(body));', 'body'],
    ['search params entries', 'return Response.json(Schema.parse(Object.fromEntries(new URL(request.url).searchParams)));', 'query'],
    ['destructured search params', "const { searchParams } = new URL(request.url);\nreturn Response.json(Schema.parse(Object.fromEntries(searchParams.entries())));", 'query'],
    ['an object of search param reads', "const url = new URL(request.url);\nreturn Response.json(Schema.parse({ title: url.searchParams.get('title') ?? undefined }));", 'query'],
    ['awaited route params', 'return Response.json(Schema.parse(await params));', 'path'],
    ['an untraceable value', 'return Response.json(Schema.parse(compute()));\nfunction compute() { return {}; }', 'unclear'],
  ])('classifies %s', async (_label, body, role) => {
    expect((await handler(body)).roles).toEqual([role]);
  });

  it('classifies a context params property', async () => {
    const result = await handler('return Response.json(Schema.parse(await ctx.params));', {
      signature: 'req: Request, ctx: { params: Promise<{ id: string }> }',
    });
    expect(result.roles).toEqual(['path']);
  });

  it('honours declared body readers', async () => {
    const body = 'return Response.json(Schema.parse(await readJsonBody(request)));';
    expect((await handler(body, { bodyReader: 'readJsonBody' })).roles).toEqual(['body']);
    expect((await handler(body)).roles).toEqual(['unclear']);
  });

  it('collects literal query keys and marks repeated ones', async () => {
    const { located, ctx } = await handler(
      "const { searchParams } = new URL(request.url);\nconst status = searchParams.getAll('status');\n"
      + "const q = searchParams.get('q');\nreturn Response.json({ status, q });",
    );
    expect(collectQueryKeys(located.scope, ctx)).toEqual({ keys: ['q', 'status'], repeated: ['status'] });
  });

  it.each([
    ['closed destructuring', 'const { title, dueDate } = await request.json();\nreturn Response.json({ title, dueDate });', { readsBody: true, keys: ['dueDate', 'title'] }],
    ['property reads', "const body = await request.json();\nreturn Response.json({ a: body.title, b: body['due'] });", { readsBody: true, keys: ['due', 'title'] }],
    ['a rest element', 'const { title, ...rest } = await request.json();\nreturn Response.json({ title, rest });', { readsBody: true, keys: 'opaque' }],
    ['a body passed on whole', 'const body = await request.json();\nreturn Response.json(save(body));\nfunction save(value: unknown) { return value; }', { readsBody: true, keys: 'opaque' }],
    ['no body read', 'return Response.json({});', { readsBody: false, keys: [] }],
  ])('derives body keys from %s', async (_label, body, expected) => {
    const { located, ctx, program } = await handler(body);
    expect(collectBodyKeys(located.fn, ctx, program.checker)).toEqual(expected);
  });
});
