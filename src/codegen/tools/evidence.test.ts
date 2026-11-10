import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { collectHandlerEvidence } from './evidence.js';
import { locateRouteHandler } from './handler-locator.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const LIB = {
  'src/lib/session.ts': "export async function getSession() { return { id: 'u1' }; }\n",
  'src/lib/auth.ts': "export function resolveSession(request: Request) { return request.headers.get('cookie'); }\n",
  'src/lib/guard.ts': "import { resolveSession } from './auth';\n"
    + 'export function requireUser(request: Request) { return resolveSession(request); }\n',
  'src/lib/outer.ts': "import { requireUser } from './guard';\n"
    + 'export function withUser(request: Request) { return requireUser(request); }\n',
  'src/lib/outermost.ts': "import { withUser } from './outer';\n"
    + 'export function viaThree(request: Request) { return withUser(request); }\n',
  'src/lib/runner.ts': "import { promisify } from 'node:util';\nimport { exec } from 'node:child_process';\n"
    + 'export const run = promisify(exec);\n',
};

async function evidenceFor(
  source: string,
  method: EndpointMethod = 'GET',
  authHelpers: string[] = [],
) {
  const route = 'src/app/api/things/route.ts';
  const app = await createAppFixture({ ...LIB, [route]: source });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const located = locateRouteHandler(program.sourceFile(app.path(route))!, method)!;
  return collectHandlerEvidence({ app: program, scope: located.scope, authHelpers });
}

describe('collectHandlerEvidence', () => {
  it('finds a default auth helper called in the handler', async () => {
    expect(await evidenceFor(
      "import { getSession } from '../../../lib/session';\n"
      + 'export async function GET() {\n  const session = await getSession();\n  return Response.json({ id: session.id });\n}\n',
    )).toEqual({ authEvidence: ['getSession'], externalCall: false });
  });

  it('follows app functions up to depth two for declared helpers', async () => {
    const helper = ['resolveSession'];
    expect((await evidenceFor(
      "import { requireUser } from '../../../lib/guard';\n"
      + 'export async function GET(request: Request) { requireUser(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual(['resolveSession']);
    expect((await evidenceFor(
      "import { withUser } from '../../../lib/outer';\n"
      + 'export async function GET(request: Request) { withUser(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual(['resolveSession']);
    expect((await evidenceFor(
      "import { viaThree } from '../../../lib/outermost';\n"
      + 'export async function GET(request: Request) { viaThree(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual([]);
  });

  it('accepts a declared wrapper around the exported handler as auth evidence', async () => {
    expect((await evidenceFor(
      "import { withAuth } from '../../../lib/with-auth';\n"
      + 'export const GET = withAuth(async () => Response.json([]));\n',
      'GET', ['withAuth'],
    )).authEvidence).toEqual(['withAuth']);
  });

  it.each([
    ["import { execFile } from 'node:child_process';\nexport async function POST() { execFile('ls'); return Response.json({}); }\n", true],
    ["import * as cp from 'child_process';\nexport async function POST() { cp.spawn('ls'); return Response.json({}); }\n", true],
    ["export async function POST() { const value = eval('1'); return Response.json({ value }); }\n", true],
    ["export async function POST() { const make = new Function('return 1'); return Response.json({ v: make() }); }\n", true],
    ["export async function POST() { const match = /a/.exec('a'); const data = await fetch('https://example.com');\n"
      + '  return Response.json({ match, ok: data.ok }); }\n', false],
  ])('flags external evidence only for child processes and dynamic code (%#)', async (source, external) => {
    expect((await evidenceFor(source, 'POST')).externalCall).toBe(external);
  });

  it.each([
    ["import { exec } from 'node:child_process';\nimport { promisify } from 'node:util';\n"
      + "export async function POST() { const run = promisify(exec); await run('ls'); return Response.json({}); }\n"],
    ["import { exec } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(exec);\n"
      + "export async function POST() { await run('ls'); return Response.json({}); }\n"],
    ["import * as cp from 'child_process';\nimport * as util from 'node:util';\nconst run = util.promisify(cp.execFile);\n"
      + "export async function POST() { await run('ls'); return Response.json({}); }\n"],
    ["import { run } from '../../../lib/runner';\nexport async function POST() { await run('ls'); return Response.json({}); }\n"],
    ["export async function POST() { const { execSync } = require('child_process'); execSync('ls'); return Response.json({}); }\n"],
    ["const cp = require('node:child_process');\nexport async function POST() { cp.execSync('ls'); return Response.json({}); }\n"],
    ["export async function POST() { const cp = await import('node:child_process'); cp.execSync('ls'); return Response.json({}); }\n"],
    ["import cp = require('child_process');\nexport async function POST() { cp.execSync('ls'); return Response.json({}); }\n"],
    ["import { exec } from 'child_process';\nexport async function POST() { const tools = { exec }; tools.exec('ls'); return Response.json({}); }\n"],
  ])('flags child processes reached through promisify, require, import() and bindings (%#)', async (source) => {
    expect((await evidenceFor(source, 'POST')).externalCall).toBe(true);
  });

  it.each([
    ["import type { ExecOptions } from 'node:child_process';\n"
      + 'export async function POST() { const options: ExecOptions = {}; return Response.json(options); }\n'],
    ["import { ExecOptions } from 'node:child_process';\n"
      + 'export async function POST() { const options: ExecOptions = {}; return Response.json(options); }\n'],
    ["import { promisify } from 'node:util';\nconst sleep = promisify(setTimeout);\n"
      + 'export async function POST() { await sleep(1); return Response.json({}); }\n'],
    ["export async function POST() { const exec = (value: string) => value; return Response.json({ v: exec('a') }); }\n"],
  ])('does not flag type-only or unrelated child_process lookalikes (%#)', async (source) => {
    expect((await evidenceFor(source, 'POST')).externalCall).toBe(false);
  });

  it('does not count auth calls in a followed binding initializer as auth evidence', async () => {
    expect(await evidenceFor(
      'const lookup = getSession();\n'
      + 'export async function GET() { return Response.json(lookup()); }\n',
    )).toEqual({ authEvidence: [], externalCall: false });
  });
});
