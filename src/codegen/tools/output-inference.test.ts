import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { analyzeRouteHandler } from './handler-analysis.js';
import { inferResponseSchema } from './output-inference.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

async function inferred(source: string) {
  const route = 'src/app/api/things/route.ts';
  const app = await createAppFixture({ [route]: source });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const analysis = analyzeRouteHandler({
    app: program,
    sourceFile: program.sourceFile(app.path(route))!,
    method: 'GET',
    conventions: { handlerWrappers: [], bodyReaders: [], authHelpers: [] },
  });
  return inferResponseSchema(program.checker, analysis.responseArguments);
}

describe('inferResponseSchema', () => {
  it('describes typed rows and skips error responses', async () => {
    expect(await inferred(
      "type Row = { id: string; status: 'open' | 'done'; due?: Date; score: number | null; tags: string[] };\n"
      + 'declare function loadRows(): Promise<Row[]>;\n'
      + 'export async function GET() {\n  const rows = await loadRows();\n'
      + "  if (rows.length > 99) return Response.json({ error: 'too many' }, { status: 413 });\n"
      + '  return Response.json({ items: rows, total: rows.length });\n}\n',
    )).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              due: { type: 'string', format: 'date-time' },
              id: { type: 'string' },
              score: { anyOf: [{ type: 'null' }, { type: 'number' }] },
              status: { type: 'string', enum: ['done', 'open'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'score', 'status', 'tags'],
          },
        },
        total: { type: 'number' },
      },
      required: ['items', 'total'],
    });
  });

  it('combines distinct success shapes with anyOf', async () => {
    expect(await inferred(
      'export async function GET(request: Request) {\n'
      + "  if (request.headers.get('x')) return Response.json({ a: 1 });\n"
      + "  return Response.json({ b: 'x' });\n}\n",
    )).toEqual({
      anyOf: [
        { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    });
  });

  it('stops at depth six', async () => {
    const schema = await inferred(
      'type Deep = { a: { b: { c: { d: { e: { f: { g: { h: string } } } } } } } };\n'
      + 'declare const deep: Deep;\nexport async function GET() { return Response.json(deep); }\n',
    ) as Record<string, any>;
    expect(schema.properties.a.properties.b.properties.c.properties.d.properties.e.properties.f.properties.g)
      .toEqual({});
  });

  it('is opaque for any-typed or missing JSON responses', async () => {
    expect(await inferred(
      "export async function GET() { const data: any = await fetch('https://example.com').then((r) => r.json());\n"
      + '  return Response.json(data); }\n',
    )).toBeUndefined();
    expect(await inferred("export async function GET() { return new Response('ok'); }\n")).toBeUndefined();
  });
});
