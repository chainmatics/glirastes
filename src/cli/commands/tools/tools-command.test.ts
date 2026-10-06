import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { formatToolStatus, type ToolStatusEntry } from './format.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const ROUTE = "declare function getSession(): Promise<unknown>;\n"
  + 'export async function GET() { await getSession(); return Response.json({ tasks: [] as string[] }); }\n'
  + 'export async function POST(request: Request) { await getSession(); const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }); }\n';

function emptyResult(overrides: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult {
  return {
    mode: 'write',
    changes: { added: [], changed: [], removed: [], unchanged: [] },
    findings: [],
    excluded: [],
    outputs: {},
    driftPaths: [],
    wrote: false,
    ...overrides,
  };
}

function harness(result: ToolsPipelineResult | (() => never) = emptyResult()) {
  const calls: ToolsPipelineOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls, out, err,
    deps: (env: NodeJS.ProcessEnv = {}, cwd = '/app') => ({
      cwd,
      env,
      log: (line: string) => { out.push(line); },
      error: (line: string) => { err.push(line); },
      runPipeline: async (options: ToolsPipelineOptions) => {
        calls.push(options);
        return typeof result === 'function' ? result() : result;
      },
    }),
  };
}

describe('glirastes tools', () => {
  it('prints usage for unknown subcommands and options', async () => {
    const h = harness();
    expect(await runToolsCommand(['generate'], h.deps())).toBe(2);
    expect(h.err.join('\n')).toContain('glirastes tools refresh');
    expect(await runToolsCommand(['refresh', '--force'], h.deps())).toBe(2);
    expect(await runToolsCommand(['refresh', '--mode', 'dry'], h.deps())).toBe(2);
  });

  it('resolves the refresh mode from flag, environment and CI', async () => {
    const h = harness();
    await runToolsCommand(['refresh'], h.deps());
    await runToolsCommand(['refresh'], h.deps({ CI: 'true' }));
    await runToolsCommand(['refresh', '--keep-going'], h.deps({ GLIRASTES_TOOLS_MODE: 'integrity' }));
    await runToolsCommand(['refresh', '--mode', 'write', '--keep-going', '--adopt', 'pilot/inventory.json', '--root', 'web'], h.deps({ CI: 'true' }));
    expect(h.calls).toEqual([
      { root: '/app', mode: 'write' },
      { root: '/app', mode: 'frozen' },
      { root: '/app', mode: 'integrity' },
      { root: '/app/web', mode: 'write', keepGoing: true, adoptInventoryPath: 'pilot/inventory.json' },
    ]);
  });

  it('exits 1 with the findings when the pipeline fails and 0 with --keep-going results', async () => {
    const failed = emptyResult({ findings: [toolFinding('E-INVENTORY-011', 'error', 'next-app', 'export * found')] });
    const h = harness(() => { throw new ToolsPipelineFailure(failed); });
    expect(await runToolsCommand(['refresh'], h.deps())).toBe(1);
    expect(h.out.join('\n')).toContain('E-INVENTORY-011');
    expect(h.out.join('\n')).toContain('Nothing was written');
    const json = harness(() => { throw new ToolsPipelineFailure(failed); });
    expect(await runToolsCommand(['refresh', '--json'], json.deps())).toBe(1);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ schemaVersion: 1, wrote: false, findings: [{ code: 'E-INVENTORY-011' }] });
    const kept = harness(failed);
    expect(await runToolsCommand(['refresh', '--keep-going'], kept.deps())).toBe(0);
  });

  it('checks frozen or integrity and honours strict mode from flag or config', async () => {
    const attention = emptyResult({
      mode: 'frozen',
      findings: [toolFinding('input-contract-unresolved', 'needs_attention', 'POST /api/x', 'unresolved')],
    });
    const fixture = await createAppFixture();
    const h = harness(attention);
    expect(await runToolsCommand(['check', '--root', fixture.root], h.deps())).toBe(0);
    expect(await runToolsCommand(['check', '--root', fixture.root, '--strict'], h.deps())).toBe(1);
    expect(await runToolsCommand(['check', '--root', fixture.root, '--integrity-only'], h.deps())).toBe(0);
    expect(h.calls.map((call) => call.mode)).toEqual(['frozen', 'frozen', 'integrity']);
    const strictApp = await createAppFixture({}, { toolsConfig: { ci: { strict: true } } });
    expect(await runToolsCommand(['check', '--root', strictApp.root], harness(attention).deps())).toBe(1);
  });

  it('refreshes a real app, explains the changes and shows what the chat can do', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const refresh = out.join('\n');
    expect(refresh).toContain('Added (2)');
    expect(refresh).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
    expect(refresh).toContain('+ tasks.create  POST /api/tasks  [write, confirmation]');
    expect(refresh).toContain('Next: Review .glirastes/setup-artifact.json');
    out.length = 0;
    expect(await runToolsCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toContain('What can my chat do? 2 active tools, 0 need attention.');
    expect(out.join('\n')).toContain('+ tasks.create  POST /api/tasks  write, asks first, Platform may relax');
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      schemaVersion: 1,
      tools: [
        {
          name: 'tasks.create', route: 'POST /api/tasks', confirmation: true, confirmationOrigin: 'code-default',
          platformMayRelax: true, contractSource: 'derived', schemaQuality: 'field-names',
        },
        {
          name: 'tasks.list', route: 'GET /api/tasks', confirmation: false, confirmationOrigin: 'code-default',
          platformMayRelax: false, contractSource: 'derived', descriptionQuality: 'template',
        },
      ],
    });
    expect(refresh).toContain('2 tools need a better description – your coding agent can do this with `glirastes tools describe --print`.');
    expect(refresh).not.toContain('need attention');
    await fixture.write('src/app/api/tasks/route.ts', ROUTE.split('export async function POST')[0]!);
    out.length = 0;
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('- tasks.create  POST /api/tasks  [removed]');
    out.length = 0;
    expect(await runToolsCommand(['check'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Tool outputs match the code.');
  }, 120_000);

  it('says which confirmations a connected Platform may relax and which tool-policy.json locks', () => {
    const entry = (name: string, extra: Partial<ToolStatusEntry>): ToolStatusEntry => ({
      toolId: `019fb004-0000-7000-8000-00000000000${name.length}`,
      name,
      route: `POST /api/${name}`,
      enabled: true,
      needsAttention: false,
      riskClass: 'write',
      confirmation: true,
      confirmationOrigin: 'code-default',
      platformMayRelax: true,
      contractSource: 'native',
      descriptionQuality: 'code',
      schemaQuality: 'zod',
      ...extra,
    });
    const status = formatToolStatus([
      entry('create', {}),
      entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false }),
      entry('purge', { riskClass: 'delete', platformMayRelax: false }),
      entry('list', { route: 'GET /api/list', riskClass: 'safe-read', confirmation: false, platformMayRelax: false }),
    ]);
    expect(status).toContain('+ create  POST /api/create  write, asks first, Platform may relax');
    expect(status).toContain('+ archive  POST /api/archive  write, asks first, locked in tool-policy.json');
    expect(status).toContain('+ purge  POST /api/purge  delete, asks first\n');
    expect(status).toContain('+ list  GET /api/list  safe-read, runs directly');
    expect(status).toContain('A Platform owner or admin can switch off a confirmation marked "Platform may relax"');
    expect(formatToolStatus([entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false })]))
      .not.toContain('Platform may relax');
  });

  it('names open stage-1 work after a refresh and enforces ci.requireEnrichment in check', async () => {
    const fixture = await createAppFixture({
      'src/app/api/tasks/route.ts': ROUTE,
      'src/app/api/raw/route.ts': 'declare function getSession(): Promise<unknown>;\ndeclare function save(value: unknown): Promise<unknown>;\n'
        + 'export async function POST(request: Request) { await getSession(); return Response.json(await save(await request.json())); }\n',
    }, { toolsConfig: { ci: { requireEnrichment: true } } });
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('1 tool needs attention – your coding agent can resolve this with `glirastes tools resolve --print`.');
    out.length = 0;
    expect(await runToolsCommand(['check'], deps)).toBe(1);
    expect(out.join('\n')).toContain('Enrichment required: 2 tool(s) have only a template description or field names (tasks.create, tasks.list).');
    out.length = 0;
    expect(await runToolsCommand(['refresh', '--json'], deps)).toBe(0);
    expect(out.join('\n')).not.toContain('coding agent');
  }, 120_000);

  it('prints the resolve work list from a frozen read and refuses to run without --print', async () => {
    const h = harness(emptyResult({ mode: 'frozen' }));
    expect(await runToolsCommand(['resolve'], h.deps())).toBe(2);
    expect(h.err.join('\n')).toContain('Glirastes never runs a model. Use --print.');
    expect(await runToolsCommand(['resolve', '--print', '--root', 'web'], h.deps())).toBe(0);
    expect(h.calls).toEqual([{ root: '/app/web', mode: 'frozen', keepGoing: true }]);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      schemaVersion: 1, kind: 'resolve', outputsCurrent: true, blocking: [], items: [], next: expect.stringContaining('glirastes tools resolve --print'),
    });
  });

  it('prints the describe work list for named tools, all tools or every gap, never without --print', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE }, { toolsConfig: { enrich: { writeContracts: true } } });
    const out: string[] = [];
    const err: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(await runToolsCommand(['describe'], deps)).toBe(2);
    expect(await runToolsCommand(['describe', '--print', '--all', 'tasks.list'], deps)).toBe(2);
    expect(await runToolsCommand(['describe', '--print', 'tasks.missing'], deps)).toBe(2);
    expect(err.join('\n')).toContain('Unknown tool tasks.missing; glirastes tools status lists the names.');
    out.length = 0;
    expect(await runToolsCommand(['describe', '--print', 'tasks.create'], deps)).toBe(0);
    const list = JSON.parse(out.join('\n')) as { kind: string; languages: string[]; writeContracts: boolean; items: Array<{ tool: string; targets: { contract?: { file: string } } }> };
    expect(list).toMatchObject({ kind: 'describe', languages: ['en'], writeContracts: true });
    expect(list.items.map((item) => [item.tool, item.targets.contract?.file])).toEqual([['tasks.create', 'src/app/api/tasks/contract.ts']]);
  }, 120_000);

  it('checks the routing of committed example sentences without a model and fails only when strict', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    await fixture.write('.glirastes/tool-semantics.json', `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/tasks', examples: { en: ['list my tasks', 'which tasks do I have', 'tasks overview'] } },
        { stableKey: 'POST /api/tasks', examples: { en: ['create a task', 'add a task called report', 'new task'] }, synonyms: { en: ['add'] } },
      ],
    })}\n`);
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    out.length = 0;
    expect(await runToolsCommand(['eval'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Routing check (top 3): 6 of 6 example sentences find their tool.');
    out.length = 0;
    expect(await runToolsCommand(['eval', '--json', '--top', '1'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      top: 1,
      summary: { sentences: 6, passed: 4, failed: 2 },
      tools: [
        { tool: 'tasks.create', failures: [] },
        { tool: 'tasks.list', failures: [{ sentence: 'tasks overview', rank: 2, competitors: ['tasks.create'] }, expect.anything()] },
      ],
    });
    out.length = 0;
    expect(await runToolsCommand(['eval', '--strict', '--top', '1'], deps)).toBe(1);
    expect(out.join('\n')).toContain('! tasks.list  "tasks overview": rank 2; ahead: tasks.create  (routing-ambiguous)');
    expect(await runToolsCommand(['eval', '--top', '0'], deps)).toBe(2);
  }, 120_000);

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
    expect(await runToolsCommand(['status', '--root', fixture.root], { log: () => undefined, error: (line) => { err.push(line); } })).toBe(1);
    expect(err.join('\n')).toContain('E-TOOLS-020');
  });
});
