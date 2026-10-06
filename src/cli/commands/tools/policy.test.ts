import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from '../../../codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const SESSION = 'declare function getSession(): Promise<unknown>;\n';
const TASKS = `${SESSION}export async function GET(request: Request) { await getSession();\n`
  + "  const { searchParams } = new URL(request.url); return Response.json({ status: searchParams.get('status') }); }\n"
  + 'export async function POST(request: Request) { await getSession(); const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }); }\n';
const TASK = `${SESSION}export async function DELETE() { await getSession(); return Response.json({ deleted: true }); }\n`;

interface Harness {
  fixture: AppFixture;
  out: string[];
  err: string[];
  run(...argv: string[]): Promise<number>;
  policy(): Promise<Record<string, unknown>>;
  tool(name: string): Promise<Record<string, unknown>>;
}

async function harness(): Promise<Harness> {
  const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': TASKS, 'src/app/api/tasks/[id]/route.ts': TASK });
  const out: string[] = [];
  const err: string[] = [];
  const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
  const h: Harness = {
    fixture,
    out,
    err,
    run: (...argv) => runToolsCommand(argv, deps),
    policy: async () => JSON.parse(await fixture.read(TOOLS_PATHS.policy)) as Record<string, unknown>,
    tool: async (name) => {
      const artifact = AppSetupArtifactSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)));
      return artifact.tools.find((tool) => tool.name === name)! as unknown as Record<string, unknown>;
    },
  };
  expect(await runToolsCommand(['refresh'], deps)).toBe(0);
  return h;
}

describe('glirastes tools policy', () => {
  it('edits the local policy by tool name and refresh applies it', async () => {
    const h = await harness();
    expect(await h.run('policy', 'disable', 'tasks.list', '--reason', 'read-only demo')).toBe(0);
    expect(h.out.at(-1)).toBe('Updated .glirastes/tool-policy.json: tasks.list is disabled. Run glirastes tools refresh to apply it.');
    expect(await h.run('policy', 'describe', 'tasks.list', 'Lists your tasks by status.')).toBe(0);
    expect(await h.run('policy', 'raise', 'tasks.create', 'delete', '--reason', 'creates billable items')).toBe(0);
    expect(await h.run('policy', 'roles', 'tasks.create', 'editor,admin,editor')).toBe(0);
    expect(await h.policy()).toEqual({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': { enabled: false, reason: 'read-only demo', description: 'Lists your tasks by status.' },
        'POST /api/tasks': { riskClass: 'delete', reason: 'creates billable items', allowedRoles: ['admin', 'editor'] },
      },
      exclude: [],
      acceptedRisk: {},
    });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ enabled: false, description: 'Lists your tasks by status.' });
    expect(await h.tool('tasks.create')).toMatchObject({ riskClass: 'delete', requiresApproval: true, allowedRoles: ['admin', 'editor'] });
    expect(await h.run('policy', 'enable', 'tasks.list')).toBe(0);
    expect(await h.run('policy', 'enable', 'tasks.list')).toBe(2);
    expect(await h.run('policy', 'reset', 'POST /api/tasks')).toBe(0);
    expect((await h.policy()).tools).toEqual({ 'GET /api/tasks': { reason: 'read-only demo', description: 'Lists your tasks by status.' } });
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.list', '--json')).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({
      tools: [{ name: 'tasks.list', stableKey: 'GET /api/tasks', local: { description: 'Lists your tasks by status.' } }],
    });
  }, 180_000);

  it('relaxes confirmation only for reviewed write tools and only raises the risk', async () => {
    const h = await harness();
    h.out.length = 0;
    expect(await h.run('policy', 'show')).toBe(0);
    expect(h.out.join('\n')).toContain('tasks.create  POST /api/tasks  write, asks first, Platform may relax, active');
    expect(h.out.join('\n')).toContain('tasks.delete  DELETE /api/tasks/:id  delete, asks first, active');
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.create', '--json')).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({
      tools: [{ name: 'tasks.create', effective: { requiresApproval: true, confirmationOrigin: 'code-default', platformMayRelax: true } }],
    });
    expect(await h.run('policy', 'relax', 'tasks.create')).toBe(2);
    expect(h.err.join('\n')).toContain('confirm the review with --yes');
    expect(await h.run('policy', 'relax', 'tasks.delete', '--yes')).toBe(2);
    expect(h.err.join('\n')).toContain('delete, financial and external tools always ask first');
    expect(await h.run('policy', 'raise', 'tasks.list', 'safe-read')).toBe(2);
    expect(h.err.join('\n')).toContain('the policy can only raise the risk');
    expect(await h.run('policy', 'relax', 'tasks.create', '--yes', '--reason', 'reviewed in PR 12')).toBe(0);
    const created = await h.tool('tasks.create');
    expect((await h.policy()).tools).toEqual({
      'POST /api/tasks': { requiresApproval: false, pin: { toolId: created.toolId, atRiskClass: 'write' }, reason: 'reviewed in PR 12' },
    });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.create')).toMatchObject({ riskClass: 'write', requiresApproval: false });
    expect(await h.run('policy', 'confirm', 'tasks.create')).toBe(0);
    expect(h.out.at(-1)).toContain('tasks.create asks before it runs, and a connected Platform can no longer switch that off'
      + ' (glirastes tools policy reset tasks.create lifts the lock)');
    expect((await h.policy()).tools).toEqual({ 'POST /api/tasks': { requiresApproval: true, reason: 'reviewed in PR 12' } });
    expect(await h.run('refresh')).toBe(0);
    h.out.length = 0;
    expect(await h.run('policy', 'show', 'tasks.create')).toBe(0);
    expect(h.out.join('\n')).toContain('tasks.create  POST /api/tasks  write, asks first, locked in tool-policy.json, active');
    expect(await h.run('policy', 'disable', 'tasks.unknown')).toBe(2);
    expect(h.err.join('\n')).toContain('Unknown tool tasks.unknown; glirastes tools status lists the names.');
  }, 180_000);

  it('excludes and includes routes and pages and removes orphaned entries', async () => {
    const h = await harness();
    expect(await h.run('policy', 'exclude', 'POST /api/tasks')).toBe(2);
    expect(await h.run('policy', 'exclude', 'tasks create', '--reason', 'x')).toBe(2);
    expect(await h.run('policy', 'exclude', 'POST /api/tasks', '--reason', 'internal')).toBe(0);
    expect(await h.run('policy', 'exclude', 'PAGE /admin/**', '--reason', 'admin pages stay manual')).toBe(0);
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.create')).toBeUndefined();
    expect(await h.run('policy', 'include', 'POST /api/tasks')).toBe(0);
    expect((await h.policy()).exclude).toEqual([{ match: 'PAGE /admin/**', reason: 'admin pages stay manual' }]);
    expect(await h.run('policy', 'include', 'POST /api/other')).toBe(2);
    await h.fixture.write(TOOLS_PATHS.policy, JSON.stringify({ schemaVersion: 1, tools: { 'GET /api/gone': { enabled: false } } }));
    expect(await h.run('policy', 'reset', 'GET /api/gone')).toBe(0);
    expect((await h.policy()).tools).toEqual({});
  }, 180_000);

  it('accepts exactly the lower risk the ratchet holds back', async () => {
    const h = await harness();
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await h.fixture.read(TOOLS_PATHS.contracts)));
    const interfaceDigest = contracts.tools.find((entry) => entry.stableKey === 'GET /api/tasks')!.contract!.interfaceDigest;
    expect(await h.run('policy', 'accept', 'tasks.list')).toBe(2);
    await h.fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({
      schemaVersion: 1, tools: { 'GET /api/tasks': { interfaceDigest, effect: 'destructive' } },
    }));
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'delete', requiresApproval: true });
    await h.fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({ schemaVersion: 1, tools: {} }));
    h.out.length = 0;
    expect(await h.run('refresh')).toBe(0);
    expect(h.out.join('\n')).toContain('risk-lower-available');
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'delete' });
    expect(await h.run('policy', 'accept', 'tasks.list')).toBe(0);
    const toolId = (await h.tool('tasks.list')).toolId;
    expect((await h.policy()).acceptedRisk).toEqual({ 'GET /api/tasks': { riskClass: 'safe-read', toolId } });
    expect(await h.run('refresh')).toBe(0);
    expect(await h.tool('tasks.list')).toMatchObject({ riskClass: 'safe-read', requiresApproval: false });
  }, 180_000);
});
