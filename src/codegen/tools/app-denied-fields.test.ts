import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { buildRuntimeArtifact, loadRuntimeArtifact } from '../../runtime-service/artifact.js';
import { toolToAiTool } from '../../server/core/index.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { loadToolsConfig, TOOLS_PATHS } from './config.js';
import { ToolContractsFileSchema } from './files.js';
import { runToolsPipeline } from './pipeline.js';
import { buildResolveWorklist } from './worklist.js';

afterEach(removeAppFixtures);

const SECURED = [{ session: [] }];
const VERSION = {
  type: 'object',
  properties: { title: { type: 'string' }, fileUrl: { type: 'string' }, thumbnailUrl: { type: 'string' }, variants: { type: 'array', items: { type: 'object', properties: { size: { type: 'integer' }, fileUrl: { type: 'string' } } } } },
};
const DESIGNS = { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, draftVersion: VERSION } } }, meta: { type: 'object', properties: { total: { type: 'integer' } } } } };
const TAGS = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } };
const URL_KEYS = ['**.fileUrl', '**.thumbnailUrl', '**.fallbackImageUrl', '**.profileImageUrl'];

function document(designsExtra: Record<string, unknown> = {}) {
  const operation = (schema: unknown, extra: Record<string, unknown> = {}) => ({
    security: SECURED, ...extra, responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
  });
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Designs', version: '1' },
    paths: { '/api/designs': { get: operation(DESIGNS, designsExtra) }, '/api/tags': { get: operation(TAGS) } },
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 's' } } },
  });
}

async function app(output: unknown, designsExtra: Record<string, unknown> = {}) {
  return createAppFixture({ 'api/openapi.json': document(designsExtra) }, {
    toolsConfig: { sources: [{ kind: 'openapi', document: 'api/openapi.json' }], ...(output !== undefined ? { output } : {}) },
  });
}

async function refresh(output: unknown, designsExtra: Record<string, unknown> = {}) {
  const fixture = await app(output, designsExtra);
  const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
  const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
  const artifact = AppSetupArtifactSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)));
  const byKey = new Map(contracts.tools.map((tool) => [tool.stableKey, tool] as const));
  const digest = (key: string) => artifact.tools.find((tool) => tool.toolId === byKey.get(key)!.toolId)!.outputSchemaDigest;
  return { fixture, result, contracts, byKey, digest };
}

describe('app-wide output.deniedFields in .glirastes/tools.json', () => {
  it('accepts only any-depth patterns and fails closed otherwise', async () => {
    const valid = await app({ deniedFields: URL_KEYS });
    expect(loadToolsConfig(valid.root).output?.deniedFields).toEqual(URL_KEYS);
    for (const bad of [{ deniedFields: ['data[].fileUrl'] }, { deniedFields: ['**.fileUrl '] }, { deniedFields: '**.fileUrl' }, { deniedFields: [null] }, { denied: [] }]) {
      const fixture = await app(bad);
      expect(() => loadToolsConfig(fixture.root)).toThrow(/E-TOOLS-002|invalid/);
      await expect(runToolsPipeline({ root: fixture.root, mode: 'write' })).rejects.toThrow();
      // Nothing was generated without the bound.
      await expect(fixture.read(TOOLS_PATHS.contracts)).rejects.toThrow();
    }
    const exact = await app({ deniedFields: ['data[].fileUrl'] });
    expect(() => loadToolsConfig(exact.root)).toThrow('output.deniedFields takes only any-depth patterns such as "**.fileUrl"');
  });

  it('joins every endpoint tool\'s own deny-list, deterministically, and reduces its contract', async () => {
    const { byKey, result } = await refresh({ deniedFields: [...URL_KEYS].reverse() }, { 'x-glirastes-output-denied-fields': ['data[].draftVersion.title', '**.fileUrl'] });
    expect(byKey.get('GET /api/designs')!.outputDeniedFields)
      .toEqual(['**.fallbackImageUrl', '**.fileUrl', '**.profileImageUrl', '**.thumbnailUrl', 'data[].draftVersion.title']);
    expect(byKey.get('GET /api/tags')!.outputDeniedFields).toEqual(['**.fallbackImageUrl', '**.fileUrl', '**.profileImageUrl', '**.thumbnailUrl']);
    const designs = JSON.stringify(byKey.get('GET /api/designs')!.contract!.output);
    expect(designs).not.toMatch(/fileUrl|thumbnailUrl|"title"/);
    // No per-tool warning for app-wide patterns a tool's schema lacks.
    expect(result.findings.filter((finding) => finding.code === 'output-field-unknown')).toEqual([]);
    const again = await refresh({ deniedFields: URL_KEYS }, { 'x-glirastes-output-denied-fields': ['**.fileUrl', 'data[].draftVersion.title'] });
    expect(await again.fixture.read(TOOLS_PATHS.contracts)).toBe(await (await refresh({ deniedFields: [...URL_KEYS].reverse() }, { 'x-glirastes-output-denied-fields': ['data[].draftVersion.title', '**.fileUrl'] })).fixture.read(TOOLS_PATHS.contracts));
  });

  it('changes only the list of a tool whose schema lacks the keys, not its schema digest', async () => {
    const plain = await refresh(undefined);
    const withList = await refresh({ deniedFields: URL_KEYS });
    expect(withList.byKey.get('GET /api/tags')!.contract).toEqual(plain.byKey.get('GET /api/tags')!.contract);
    expect(withList.digest('GET /api/tags')).toBe(plain.digest('GET /api/tags'));
    expect(withList.digest('GET /api/designs')).not.toBe(plain.digest('GET /api/designs'));
    // Without the field nothing changes.
    expect(await plain.fixture.read(TOOLS_PATHS.contracts)).not.toContain('outputDeniedFields');
  });

  it('warns once about a pattern no tool\'s schema names, on tools.json, with a near miss', async () => {
    const { result } = await refresh({ deniedFields: ['**.fileUrl', '**.fileurl', '**.nothere'] });
    const unmatched = result.findings.filter((finding) => finding.code === 'output-denied-key-unmatched');
    expect(unmatched.map((finding) => [finding.severity, finding.subjectRef])).toEqual([
      ['warning', TOOLS_PATHS.config], ['warning', TOOLS_PATHS.config],
    ]);
    expect(unmatched[0]!.message).toContain('**.fileurl, whose key is not found in the declared response schema of any tool (the schemas have fileUrl');
    expect(unmatched[1]!.message).toContain('**.nothere');
    expect(unmatched[1]!.message).toContain('if the field only occurs in undeclared parts, ignore this');
    const items = buildResolveWorklist(result).items.filter((item) => item.code === 'output-denied-key-unmatched');
    expect(items[0]).toMatchObject({ owner: 'developer', target: { kind: 'review', file: TOOLS_PATHS.config, key: 'output.deniedFields' } });
  });

  it('keeps a tool with an invalid own deny-list fail-closed', async () => {
    const { byKey, result } = await refresh({ deniedFields: URL_KEYS }, { 'x-glirastes-output-denied-fields': ['data[0]'] });
    expect(result.findings.some((finding) => finding.code === 'output-denied-fields-invalid' && finding.severity === 'needs_attention')).toBe(true);
    expect(byKey.get('GET /api/designs')!.outputAllowedFields).toEqual([]);
  });

  it('applies end to end in the container: build, bindings, model-facing result', async () => {
    const fixture = await app({ deniedFields: URL_KEYS });
    await buildRuntimeArtifact({ projectRoot: fixture.root, outputDirectory: fixture.path('artifact') });
    const loaded = await loadRuntimeArtifact(fixture.path('artifact'));
    const binding = loaded.createToolBindings().find((candidate) => candidate.executionKind === 'endpoint' && candidate.path === '/api/designs')!;
    expect(binding.tool.outputDeniedFields).toEqual(['**.fallbackImageUrl', '**.fileUrl', '**.profileImageUrl', '**.thumbnailUrl']);
    const body = {
      data: [{ id: 'd0', profileImageUrl: 'P-SIG', draftVersion: { title: 'T', fileUrl: 'F-SIG', thumbnailUrl: 'T-SIG', variants: [{ size: 1, fileUrl: 'V-SIG', fallbackImageUrl: 'B-SIG' }] } }],
      meta: { total: 1 },
    };
    const context = { currentDate: new Date(0), locale: 'en-US', callEndpoint: async () => ({ ok: true, status: 200, data: body }) } as never;
    const shown = JSON.stringify(await toolToAiTool(binding.tool, context, 'designs').execute({}));
    expect(shown).not.toMatch(/SIG|fileUrl|thumbnailUrl|fallbackImageUrl|profileImageUrl/);
    expect(shown).toContain('"title":"T"');
  });
});
