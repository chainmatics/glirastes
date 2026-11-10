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

  describe('refuses what the generator does not accept as current', () => {
    const OTHER_DIGEST = `sha256:${'A'.repeat(43)}`;
    const WRAPPED = {
      'src/app/api/wrapped/route.ts': "import { handlers } from './handlers';\nexport const GET = handlers.GET;\n",
      'src/app/api/wrapped/handlers.ts': 'export const handlers = { GET: async () => Response.json([]) };\n',
    };

    async function prepare(extra: Record<string, string> = {}) {
      const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE, ...extra });
      const out: string[] = [];
      const err: string[] = [];
      const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
      expect(await runToolsCommand(['refresh'], deps)).toBe(0);
      const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
      const interfaceDigest = contracts.tools.find((tool) => tool.stableKey === 'GET /api/tasks')!.contract!.interfaceDigest;
      const files = async () => [await fixture.read(TOOLS_PATHS.resolutions).catch(() => ''), await fixture.read(TOOLS_PATHS.semantics).catch(() => '')];
      return { fixture, deps, out, err, interfaceDigest, files };
    }

    const resolution = (interfaceDigest: string, input: Record<string, unknown> = { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false }) => ({
      origin: 'agent', model: 'claude-code', interfaceDigest, input: { jsonSchema: input },
    });
    const semanticsEntry = (interfaceDigest: string, extra: Record<string, unknown> = {}) => ({
      stableKey: 'GET /api/tasks',
      description: 'Lists the tasks of the caller.',
      origin: { description: 'agent' },
      agent: { model: 'claude-code', interfaceDigest },
      ...extra,
    });

    it('refuses a stale or rejected agent resolution and changes nothing', async () => {
      const { fixture, deps, err, interfaceDigest, files } = await prepare();
      const stale = { schemaVersion: 1, tools: { 'GET /api/tasks': resolution(OTHER_DIGEST) } };
      const rejected = {
        schemaVersion: 1,
        tools: { 'GET /api/tasks': resolution(interfaceDigest, { type: 'object', properties: {}, additionalProperties: false }) },
      };
      for (const file of [stale, rejected]) {
        await fixture.write(TOOLS_PATHS.resolutions, JSON.stringify(file));
        const before = await files();
        expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
        expect(await runToolsCommand(['verify', '--all'], deps)).toBe(2);
        expect(await files()).toEqual(before);
      }
      expect(err.join('\n')).toContain('The tool-resolutions.json entry of tasks.list is rejected or stale');
    }, 180_000);

    it('refuses agent semantics written for an earlier interface', async () => {
      const { fixture, deps, err, files } = await prepare();
      await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({ schemaVersion: 1, tools: [semanticsEntry(OTHER_DIGEST)] }));
      const before = await files();
      expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
      expect(err.join('\n')).toContain('The tool-semantics.json entry of tasks.list is rejected or stale');
      expect(await files()).toEqual(before);
    }, 180_000);

    it('refuses --all while one agent entry is rejected, but verifies the named tools', async () => {
      const { fixture, deps, out, interfaceDigest, files } = await prepare({ 'src/app/api/notes/route.ts': ROUTE });
      await fixture.write(TOOLS_PATHS.resolutions, JSON.stringify({ schemaVersion: 1, tools: { 'GET /api/tasks': resolution(interfaceDigest) } }));
      await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({
        schemaVersion: 1,
        tools: [semanticsEntry(interfaceDigest, { stableKey: 'GET /api/notes', description: 'Mail anna@kunde.de' })],
      }));
      const before = await files();
      expect(await runToolsCommand(['verify', '--all'], deps)).toBe(2);
      expect(await files()).toEqual(before);
      expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
      expect(out.at(-1)).toBe('Verified tasks.list (contract): reviewed and locked. Run glirastes tools refresh.');
    }, 180_000);

    it('locks the entry the generator keys on: a padded key, a padded name and the name fallback', async () => {
      const { fixture, deps, out, interfaceDigest } = await prepare();
      const agent = { model: 'claude-code', interfaceDigest };
      const shadowed = semanticsEntry(interfaceDigest, { description: 'Mail anna@kunde.de' });
      const padded = semanticsEntry(interfaceDigest, { stableKey: ' GET /api/tasks ' });
      await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({ schemaVersion: 1, tools: [shadowed, padded] }));
      expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
      const keyed = JSON.parse(await fixture.read(TOOLS_PATHS.semantics)).tools;
      expect(keyed[0]).toEqual(shadowed);
      expect(keyed[1]).toMatchObject({ origin: { description: 'human' }, locked: { description: expect.stringMatching(/^sha256:/) } });
      expect(keyed[1].agent).toBeUndefined();

      const named = { name: ' tasks.list ', description: 'Lists the tasks of the caller.', origin: { description: 'agent' }, agent };
      const earlier = { name: 'tasks.list', description: 'Mail anna@kunde.de', origin: { description: 'agent' }, agent };
      await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({ schemaVersion: 1, tools: [earlier, named] }));
      expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(0);
      expect(out.at(-1)).toBe('Verified tasks.list (description): reviewed and locked. Run glirastes tools refresh.');
      const byName = JSON.parse(await fixture.read(TOOLS_PATHS.semantics)).tools;
      expect(byName[0]).toEqual(earlier);
      expect(byName[1]).toMatchObject({ origin: { description: 'human' }, locked: { description: expect.stringMatching(/^sha256:/) } });
    }, 180_000);

    it('refuses to lock entries of a file the generator ignores', async () => {
      const { fixture, deps, err, interfaceDigest, files } = await prepare();
      const ignoredSemantics = { schemaVersion: 2, tools: [semanticsEntry(interfaceDigest, { description: 'Mail anna@kunde.de' })] };
      const ignoredResolutions = { schemaVersion: 2, tools: { 'GET /api/tasks': resolution(interfaceDigest) } };
      for (const [path, code, file] of [
        [TOOLS_PATHS.semantics, 'tool-semantics-invalid', ignoredSemantics],
        [TOOLS_PATHS.resolutions, 'resolution-rejected', ignoredResolutions],
      ] as const) {
        await fixture.write(path, JSON.stringify(file));
        const before = await files();
        err.length = 0;
        expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
        expect(err.join('\n')).toContain(`${path}  ${code}: ${path.split('/').at(-1)} does not match its schema and is ignored.`);
        expect(await runToolsCommand(['verify', '--all'], deps)).toBe(2);
        expect(await files()).toEqual(before);
        await fixture.remove(path);
      }
    }, 180_000);

    it('refuses entries of a tool whose handler cannot be read, because their interface cannot be checked', async () => {
      const { fixture, deps, err, files } = await prepare(WRAPPED);
      const contract = { schemaVersion: 1, tools: { 'GET /api/wrapped': resolution(OTHER_DIGEST, { type: 'object', properties: {}, additionalProperties: false }) } };
      const description = { schemaVersion: 1, tools: [semanticsEntry(OTHER_DIGEST, { stableKey: 'GET /api/wrapped' })] };
      for (const [path, file, name] of [
        [TOOLS_PATHS.resolutions, contract, 'tool-resolutions.json'],
        [TOOLS_PATHS.semantics, description, 'tool-semantics.json'],
      ] as const) {
        await fixture.write(path, JSON.stringify(file));
        const before = await files();
        err.length = 0;
        expect(await runToolsCommand(['verify', 'wrapped.list'], deps)).toBe(2);
        expect(err.join('\n')).toContain(`The ${name} entry of wrapped.list cannot be checked: the generator cannot read the handler of this tool.`);
        expect(await runToolsCommand(['verify', '--all'], deps)).toBe(2);
        expect(await files()).toEqual(before);
        await fixture.remove(path);
      }
    }, 180_000);

    it('reports a pipeline that stopped early instead of "no agent-written entries"', async () => {
      const { fixture, deps, out, err, interfaceDigest, files } = await prepare();
      await fixture.write(TOOLS_PATHS.semantics, JSON.stringify({ schemaVersion: 1, tools: [semanticsEntry(interfaceDigest)] }));
      for (const [path, code] of [[TOOLS_PATHS.policy, 'E-POLICY-001'], [TOOLS_PATHS.inventory, 'generation-state-invalid']] as const) {
        const good = await fixture.read(path).catch(() => undefined);
        await fixture.write(path, '{ not json');
        const before = await files();
        out.length = 0;
        err.length = 0;
        expect(await runToolsCommand(['verify', '--all'], deps)).toBe(2);
        expect(err.join('\n')).toContain(code);
        expect(await runToolsCommand(['verify', 'tasks.list'], deps)).toBe(2);
        expect(err.join('\n')).not.toContain('Unknown tool');
        expect(out).toEqual([]);
        expect(await files()).toEqual(before);
        if (good === undefined) await fixture.remove(path);
        else await fixture.write(path, good);
      }
    }, 180_000);
  });
});
