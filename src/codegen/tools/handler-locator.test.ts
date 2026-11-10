import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { locateRouteHandler, normalizedNodeText } from './handler-locator.js';

function locate(source: string, method: EndpointMethod) {
  const sourceFile = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  return { sourceFile, located: locateRouteHandler(sourceFile, method) };
}

describe('locateRouteHandler', () => {
  it('reads an exported function declaration with JSDoc and parameters', () => {
    const { located } = locate(
      '/**\n * GET /api/things/:id\n * Shows one thing\n * for the caller.\n */\n'
      + 'export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {\n'
      + '  return Response.json({ id: (await params).id });\n}\n',
      'GET',
    );
    expect(located).toMatchObject({
      jsDoc: 'Shows one thing for the caller.',
      requestName: 'request',
      paramsName: 'params',
    });
    expect(located?.fn !== undefined && ts.isFunctionDeclaration(located.fn)).toBe(true);
  });

  it('finds the inline handler inside a wrapper export', () => {
    const { located } = locate(
      "import { withAuth } from './auth';\n/** Creates a thing. */\n"
      + 'export const POST = withAuth(async (req: Request, ctx: { params: Promise<{ id: string }> }) => '
      + 'Response.json(await req.json()));\n',
      'POST',
    );
    expect(located).toMatchObject({ jsDoc: 'Creates a thing.', requestName: 'req', contextName: 'ctx' });
    expect(located?.fn !== undefined && ts.isArrowFunction(located.fn)).toBe(true);
    expect(located?.scope !== undefined && ts.isCallExpression(located.scope)).toBe(true);
  });

  it('follows a local handler exported under an alias', () => {
    const { located } = locate(
      'const handler = async (request: Request) => Response.json([]);\nexport { handler as DELETE };\n',
      'DELETE',
    );
    expect(located?.requestName).toBe('request');
  });

  it('keeps an unreadable export locatable but without a function', () => {
    const { located } = locate(
      "import { handlers } from './handlers';\nexport const PATCH = handlers.PATCH;\n",
      'PATCH',
    );
    expect(located).toBeDefined();
    expect(located?.fn).toBeUndefined();
  });

  it('returns undefined for a method the route does not export', () => {
    expect(locate('export async function GET() { return Response.json([]); }\n', 'PUT').located)
      .toBeUndefined();
  });

  it('normalizes comments and whitespace out of the handler text', () => {
    const first = locate('export async function GET() {\n  // list\n  return Response.json([]);\n}\n', 'GET');
    const second = locate('export async function GET() { return   Response.json([]); }\n', 'GET');
    expect(normalizedNodeText(first.located!.scope, first.sourceFile))
      .toBe(normalizedNodeText(second.located!.scope, second.sourceFile));
  });

  it('normalizes quote style and trailing commas out of the handler text', () => {
    const text = (source: string) => {
      const { located, sourceFile } = locate(source, 'GET');
      return normalizedNodeText(located!.scope, sourceFile);
    };
    const single = "export async function GET() { const a = 1; return Response.json({ a, k: 'x', list: [a, 'y'] }); }\n";
    const formatted = 'export async function GET() {\n  // list\n  const a = 1;\n'
      + '  return Response.json({\n    a,\n    k: "x",\n    list: [a, "y",],\n  },);\n}\n';
    expect(text(formatted)).toBe(text(single));
    expect(text("export async function GET() { return Response.json({ k: 'z' }); }\n"))
      .not.toBe(text("export async function GET() { return Response.json({ k: 'x' }); }\n"));
  });
});
