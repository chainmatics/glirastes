import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolReportFileSchema } from '../../../codegen/tools/artifact.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const ROUTE = 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET(request: Request) { await getSession();\n'
  + "  const { searchParams } = new URL(request.url); return Response.json({ status: searchParams.get('status') }); }\n";

describe('glirastes tools verify', () => {
  it('turns reviewed agent entries into locked human entries that a later agent edit cannot change', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    const out: string[] = [];
    const err: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    const interfaceDigest = contracts.tools[0]!.contract!.interfaceDigest;
    const description = 'Lists the tasks of the caller, optionally by status.';
    await fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': {
          origin: 'agent', model: 'claude-code', interfaceDigest,
          input: { jsonSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done'] } }, additionalProperties: false } },
        },
      },
    }));
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'GET /api/tasks', description, origin: { description: 'agent' }, agent: { model: 'claude-code', interfaceDigest } }],
    }));
    expect(await runToolsCommand(['verify'], deps)).toBe(2);
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
    expect(out.at(-1)).toBe('Verified tasks.list (contract and description): reviewed and locked. Run glirastes tools refresh.');
    const resolutions = JSON.parse(await fixture.read(TOOLS_PATHS.resolutions));
    expect(resolutions.tools['GET /api/tasks']).toMatchObject({ origin: 'human', model: 'claude-code', locked: expect.stringMatching(/^sha256:/) });
    const semantics = JSON.parse(await fixture.read(TOOLS_PATHS.semantics));
    expect(semantics.tools[0]).toEqual({
      stableKey: 'GET /api/tasks', description, origin: { description: 'human' }, locked: { description: expect.stringMatching(/^sha256:/) },
    });
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!).tools[0]).toMatchObject({ descriptionQuality: 'human', schemaQuality: 'json-schema' });
    expect(await runToolsCommand(['verify', '--all'], deps)).toBe(0);
    expect(out.at(-1)).toBe('No agent-written entries to verify.');
    semantics.tools[0].description = 'Agent rewrite.';
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify(semantics));
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const report = ToolReportFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.report)));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'resolution-rejected', subjectRef: 'GET /api/tasks' }));
    expect(report.tools[0]?.quality.description).toBe('template');
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
    expect(err.join('\n')).toContain('tasks.list has no agent-written entry to verify.');
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'GET /api/tasks', description: 'Mail anna@kunde.de', origin: { description: 'agent' }, agent: { model: 'codex', interfaceDigest } }],
    }));
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
    expect(err.join('\n')).toContain('The tool-semantics.json entry of tasks.list is rejected or stale');
  }, 180_000);

  it('locks the semantics entry the generator uses, not an earlier duplicate it shadows', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    const out: string[] = [];
    const err: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    const agent = { model: 'claude-code', interfaceDigest: contracts.tools[0]!.contract!.interfaceDigest };
    const shadowed = { stableKey: 'GET /api/tasks', description: 'Mail anna@kunde.de', origin: { description: 'agent' }, agent };
    const used = { stableKey: 'GET /api/tasks', description: 'Lists the tasks of the caller.', origin: { description: 'agent' }, agent };
    await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({ schemaVersion: 1, tools: [shadowed, used] }));
    expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
    const { tools } = JSON.parse(await fixture.read(TOOLS_PATHS.semantics));
    expect(tools[0]).toEqual(shadowed);
    expect(tools[1]).toEqual({
      stableKey: 'GET /api/tasks', description: used.description, origin: { description: 'human' }, locked: { description: expect.stringMatching(/^sha256:/) },
    });
    expect(err).toEqual([]);
  }, 180_000);
});
