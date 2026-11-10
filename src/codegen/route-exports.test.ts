import { describe, expect, it } from 'vitest';
import { readRouteExports } from './route-exports.js';

describe('route export diagnostics', () => {
  it('resolves exported overload signatures through their single implementation', () => {
    const result = readRouteExports(`
      export function GET(request: Request): Promise<Response>;
      export async function GET(request: Request) { return Response.json([]); }
    `);
    expect(result.exports).toEqual([{ method: 'GET', body: '{ return Response.json([]); }' }]);
    expect(result.findings).toEqual([]);
  });

  it('does not treat a declaration without an implementation as an executable export', () => {
    expect(readRouteExports('export declare function GET(request: Request): Promise<Response>;'))
      .toEqual({ exports: [], findings: [{ exportName: 'GET', code: 'route-export-unresolved' }] });
  });

  it.each([
    'export const GET = async () => ;',
    'export async function GET() {',
  ])('never accepts a syntax-recovered route', (source) => {
    expect(readRouteExports(source)).toEqual({
      exports: [], findings: [{ code: 'route-source-invalid' }],
    });
  });

  it('reports destructured handler exports without executing their initializer', () => {
    expect(readRouteExports('export const { GET, post: POST } = handlers;')).toEqual({
      exports: [], findings: [
        { exportName: 'GET', code: 'route-export-unresolved' },
        { exportName: 'POST', code: 'route-export-unresolved' },
      ],
    });
  });

  it('reads a HEAD export like every other route method', () => {
    expect(readRouteExports('export async function HEAD() { return new Response(null); }\nexport const OPTIONS = () => null;'))
      .toEqual({ exports: [{ method: 'HEAD', body: '{ return new Response(null); }' }], findings: [] });
  });

  it('reports namespace HTTP exports as unresolved', () => {
    expect(readRouteExports('export * as GET from "./handlers";')).toEqual({
      exports: [], findings: [{ exportName: 'GET', code: 'route-export-unresolved' }],
    });
  });
});
