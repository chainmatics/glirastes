import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
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
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      schemaVersion: 1,
      tools: [
        { name: 'tasks.create', route: 'POST /api/tasks', confirmation: true, contractSource: 'derived', schemaQuality: 'field-names' },
        { name: 'tasks.list', route: 'GET /api/tasks', confirmation: false, contractSource: 'derived', descriptionQuality: 'template' },
      ],
    });
    await fixture.write('src/app/api/tasks/route.ts', ROUTE.split('export async function POST')[0]!);
    out.length = 0;
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('- tasks.create  POST /api/tasks  [removed]');
    out.length = 0;
    expect(await runToolsCommand(['check'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Tool outputs match the code.');
  }, 120_000);

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
    expect(await runToolsCommand(['status', '--root', fixture.root], { log: () => undefined, error: (line) => { err.push(line); } })).toBe(1);
    expect(err.join('\n')).toContain('E-TOOLS-020');
  });
});
