import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatToolsHuman } from '../../cli/commands/tools/format.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../../contracts/index.js';
import { deriveToolPolicyDefaults, resolveToolPolicy, type EffectiveToolPolicy } from '../../contracts/tool-policy.js';
import { applyPolicyOverlay } from '../../runtime/policy-overlay.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT, type AppFixture } from './__tests__/app-fixture.js';
import { generatedModulePath, loadToolsConfig, TOOLS_PATHS } from './config.js';
import { applyCodeRoles, disjointCodeRolesFinding, runToolsPipelineWith, type ToolsPipelineResult } from './pipeline.js';
import { buildResolveWorklist } from './worklist.js';

afterEach(removeAppFixtures);

const NOW = () => new Date('2026-11-16T00:00:00.000Z');

/** The committed OpenAPI documents of the examples; their outputs must not move with the opt-in extensions. */
const COMMITTED_DOCUMENTS = [
  'examples/vue-fastapi/api/openapi.json',
  'examples/php-runtime/api/openapi.json',
  'examples/openapi.todo.json',
  'examples/openapi-3.0.tasks.json',
];

const OUTPUTS = [
  TOOLS_PATHS.inventory,
  TOOLS_PATHS.contracts,
  TOOLS_PATHS.report,
  TOOLS_PATHS.setupArtifact,
];

async function outputDigests(document: string, source: unknown): Promise<Record<string, string>> {
  const fixture = await createAppFixture(
    { 'openapi.json': await readFile(join(SDK_ROOT, document), 'utf8') },
    { toolsConfig: { sources: [source] } },
  );
  const result = await runToolsPipelineWith({ root: fixture.root, mode: 'write', keepGoing: true }, { now: NOW });
  const module = generatedModulePath(loadToolsConfig(fixture.root));
  return Object.fromEntries([...OUTPUTS, module].map((path) => [
    path === module ? 'module' : path,
    createHash('sha256').update(result.outputs[path] ?? '').digest('hex').slice(0, 16),
  ]));
}

describe('the openapi source without the opt-in extensions', () => {
  it('writes the same outputs as before for every committed example document', async () => {
    const digests: Record<string, Record<string, string>> = {};
    for (const document of COMMITTED_DOCUMENTS) {
      const bare = await outputDigests(document, 'openapi');
      expect(await outputDigests(document, { kind: 'openapi', document: 'openapi.json' })).toEqual(bare);
      digests[document] = bare;
    }
    // Pinned from 0.14.0 plus OpenAPI 3.0 support, before `selection` and the x-glirastes-* extensions existed.
    expect(digests).toMatchInlineSnapshot(`
      {
        "examples/openapi-3.0.tasks.json": {
          ".glirastes/foundation-execution-inventory.json": "4d05efc43237b748",
          ".glirastes/setup-artifact.json": "95934e26f30c5bc6",
          ".glirastes/tool-contracts.json": "8fa73a99f0e4d03b",
          ".glirastes/tool-report.json": "6cf74c24550678c4",
          "module": "7e5c3a014eeb1317",
        },
        "examples/openapi.todo.json": {
          ".glirastes/foundation-execution-inventory.json": "750c73e649638336",
          ".glirastes/setup-artifact.json": "ea1c6ac8133e5ba3",
          ".glirastes/tool-contracts.json": "24cc7eb0436fc565",
          ".glirastes/tool-report.json": "555cec9eb5d05788",
          "module": "5892c7bbf0795a84",
        },
        "examples/php-runtime/api/openapi.json": {
          ".glirastes/foundation-execution-inventory.json": "e25bb3820cdb3aa1",
          ".glirastes/setup-artifact.json": "271f44587c09988b",
          ".glirastes/tool-contracts.json": "624b4530a1aaa84b",
          ".glirastes/tool-report.json": "015806f5bf3cd8a1",
          "module": "58d4277081607834",
        },
        "examples/vue-fastapi/api/openapi.json": {
          ".glirastes/foundation-execution-inventory.json": "63da202d5e7280cf",
          ".glirastes/setup-artifact.json": "012ef8a6afdd9599",
          ".glirastes/tool-contracts.json": "335ebed18b38ef75",
          ".glirastes/tool-report.json": "f5f615ed8686b5fa",
          "module": "0554be95b97e371d",
        },
      }
    `);
  }, 60_000);
});

const OPT_IN_FIXTURE = join(SDK_ROOT, 'examples/openapi-3.0.opt-in.json');
const OPT_IN_SOURCE = { kind: 'openapi', document: 'openapi.json', selection: 'opt-in' };

type Spec = { paths: Record<string, Record<string, Record<string, unknown>>> };

async function optInSpec(): Promise<Spec> {
  return JSON.parse(await readFile(OPT_IN_FIXTURE, 'utf8')) as Spec;
}

async function optInApp(options: { spec?: Spec; locale?: string; policy?: unknown } = {}): Promise<AppFixture> {
  return createAppFixture({
    'openapi.json': JSON.stringify(options.spec ?? await optInSpec()),
    ...(options.policy ? { '.glirastes/tool-policy.json': JSON.stringify(options.policy) } : {}),
  }, {
    toolsConfig: { sources: [OPT_IN_SOURCE], locale: options.locale ?? 'de-DE', emit: { mcpCatalog: true } },
  });
}

async function refresh(app: AppFixture): Promise<ToolsPipelineResult> {
  return runToolsPipelineWith({ root: app.root, mode: 'write', keepGoing: true }, { now: NOW });
}

function artifactOf(result: ToolsPipelineResult): AppSetupArtifact {
  return AppSetupArtifactSchema.parse(JSON.parse(result.outputs[TOOLS_PATHS.setupArtifact]!));
}

function candidates(result: ToolsPipelineResult) {
  return new Map(artifactOf(result).tools.map((tool) => [`${tool.method} ${tool.path}`, tool]));
}

describe('an opt-in OpenAPI source through the tools pipeline', () => {
  it('generates exactly the marked operations with their names, group and roles', async () => {
    const app = await optInApp();
    const result = await refresh(app);

    expect(result.wrote).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect((result.tools ?? []).map((tool) => [tool.stableKey, tool.definitionId, tool.module, tool.enabled]).sort()).toEqual([
      ['DELETE /api/tags/:tagId', 'delete_tag', 'tag', true],
      ['GET /api/tags', 'list_tags', 'tag', true],
      ['PATCH /api/tags/:tagId', 'update_tag', 'tag', true],
      ['POST /api/tags', 'create_tag', 'tag', true],
    ]);
    expect(result.excluded).toEqual([
      { stableKey: 'DELETE /api/tasks/:taskId', reason: 'opted-out', origin: 'code' },
      { stableKey: 'GET /api/reports', reason: 'not-opted-in', origin: 'code' },
      { stableKey: 'GET /api/tasks', reason: 'not-opted-in', origin: 'code' },
      { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
      { stableKey: 'POST /api/tasks', reason: 'not-opted-in', origin: 'code' },
      { stableKey: 'POST /api/tasks/:taskId/attachments', reason: 'unsupported-body', origin: 'code' },
    ]);
    // Roles on unmarked operations (one of them malformed) report nothing; a malformed marker and an excluded marked operation do.
    expect(result.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['opt-in-excluded', 'POST /api/auth/login'],
      ['output-contract-opaque', 'DELETE /api/tags/:tagId'],
      ['tool-marker-invalid', 'GET /api/reports'],
    ]);
    // Neither finding is swallowed because its operation is no tool.
    const report = JSON.parse(result.outputs[TOOLS_PATHS.report]!) as { findings: Array<{ code: string }>; excluded: unknown[] };
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['opt-in-excluded', 'tool-marker-invalid']));
    expect(report.excluded).toHaveLength(6);

    expect(Object.fromEntries([...candidates(result)].map(([key, tool]) => [key, {
      name: tool.name,
      module: tool.module,
      allowedRoles: tool.allowedRoles,
      label: tool.presentation?.singular,
      rolesOrigin: tool.provenance?.policyOrigin?.allowedRoles,
    }]))).toEqual({
      'DELETE /api/tags/:tagId': { name: 'delete_tag', module: 'tag', allowedRoles: ['admin', 'tag.delete'], label: 'Tags löschen', rolesOrigin: 'code-default' },
      'GET /api/tags': { name: 'list_tags', module: 'tag', allowedRoles: ['tag.read'], label: 'Tags auflisten', rolesOrigin: 'code-default' },
      'PATCH /api/tags/:tagId': { name: 'update_tag', module: 'tag', allowedRoles: ['tag.write'], label: 'Tags ändern', rolesOrigin: 'code-default' },
      'POST /api/tags': { name: 'create_tag', module: 'tag', allowedRoles: ['tag.write'], label: 'Tags anlegen', rolesOrigin: 'code-default' },
    });
    // The generated module (its MCP catalog included) carries the same roles.
    const module = result.outputs[generatedModulePath(loadToolsConfig(app.root))]!;
    expect(module.match(/"tag\.delete"/g)).toHaveLength(2);
    expect(module.match(/"tag\.write"/g)).toHaveLength(4);

    // Stable across a second refresh with the inventory it just wrote.
    const again = await refresh(app);
    expect(again.wrote).toBe(false);
    expect((again.tools ?? []).map((tool) => tool.definitionId).sort()).toEqual(['create_tag', 'delete_tag', 'list_tags', 'update_tag']);
  }, 60_000);

  it('labels the tools in English without repeating the verb', async () => {
    const result = await refresh(await optInApp({ locale: 'en-US' }));
    expect(Object.fromEntries([...candidates(result)].map(([key, tool]) => [key, tool.presentation?.singular]))).toEqual({
      'DELETE /api/tags/:tagId': 'Delete tags',
      'GET /api/tags': 'List tags',
      'PATCH /api/tags/:tagId': 'Update tags',
      'POST /api/tags': 'Create tags',
    });
  }, 60_000);

  it('collapses not-opted-in operations into one CLI line with a fitting next step', async () => {
    const text = formatToolsHuman(await refresh(await optInApp()));
    expect(text).toContain('Excluded (6)');
    expect(text).toContain('  . 3 OpenAPI operations  not-opted-in (code), listed in .glirastes/tool-report.json');
    expect(text).not.toContain('GET /api/tasks  not-opted-in');
    expect(text).toContain('  . POST /api/auth/login  auth-route (default)');
    expect(text).toContain('mark it with x-glirastes-tool: true');
    // Under opt-in, removing the marker would leave the operation out: the advice is to set it to true.
    expect(text).toContain('x-glirastes-tool: false keeps an operation out; set it to true to include the operation, unless an exclusion rule applies to it.');
    expect(text).not.toContain('remove it to include');
  }, 60_000);

  it('reports no disjoint roles for operations that are not tools or for a tool the policy itself disables', async () => {
    const spec = await optInSpec();
    // Unmarked, with roles: no tool, so its roles are never read.
    spec.paths['/api/tasks']!.get!['x-glirastes-roles'] = ['task.read'];
    const result = await refresh(await optInApp({
      spec,
      policy: {
        schemaVersion: 1,
        tools: {
          'GET /api/tasks': { allowedRoles: ['guest'] },
          // Switched off, with roles the code (tag.read) does not share: the switch disables it, not the roles.
          'GET /api/tags': { enabled: false, allowedRoles: ['guest'] },
        },
      },
    }));
    expect(result.tools!.map((tool) => tool.stableKey)).not.toContain('GET /api/tasks');
    expect(candidates(result).get('GET /api/tags')).toMatchObject({
      enabled: false, provenance: { policyOrigin: { enabled: 'local-policy' } },
    });
    expect(result.findings.map((finding) => finding.code)).not.toContain('policy-roles-disjoint');
    expect(result.outputs[TOOLS_PATHS.report]).not.toContain('policy-roles-disjoint');
  }, 60_000);

  it('disables a marked operation whose roles are invalid (fail closed)', async () => {
    const spec = await optInSpec();
    spec.paths['/api/tags']!.get!['x-glirastes-roles'] = 'tag.read';
    const result = await refresh(await optInApp({ spec }));
    const list = result.tools!.find((tool) => tool.stableKey === 'GET /api/tags')!;
    expect(list.enabled).toBe(false);
    expect(list.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tool-roles-invalid', severity: 'needs_attention' }),
    ]));
    expect(candidates(result).get('GET /api/tags')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 60_000);

  it('lets tool-policy.json and the Platform only narrow the code roles', async () => {
    const result = await refresh(await optInApp({
      policy: {
        schemaVersion: 1,
        tools: {
          // Wider than the code roles: does not widen access.
          'POST /api/tags': { allowedRoles: ['tag.write', 'guest'] },
          // Narrower: applies, attributed to the local policy.
          'DELETE /api/tags/:tagId': { allowedRoles: ['admin'] },
          // Disjoint: nobody may call the tool.
          'GET /api/tags': { allowedRoles: ['guest'] },
        },
      },
    }));
    const tools = candidates(result);
    expect(tools.get('POST /api/tags')).toMatchObject({
      enabled: true, allowedRoles: ['tag.write'], provenance: { policyOrigin: { allowedRoles: 'code-default' } },
    });
    expect(tools.get('DELETE /api/tags/:tagId')).toMatchObject({
      enabled: true, allowedRoles: ['admin'], provenance: { policyOrigin: { allowedRoles: 'local-policy' } },
    });
    expect(tools.get('GET /api/tags')).toMatchObject({
      enabled: false, allowedRoles: [], provenance: { policyOrigin: { enabled: 'local-policy', allowedRoles: 'local-policy' } },
    });
    // Disabled, but never silently: the finding names the tool and both role sets. Narrowing alone reports nothing.
    const disjoint = result.findings.filter((finding) => finding.code === 'policy-roles-disjoint');
    expect(disjoint).toEqual([expect.objectContaining({
      severity: 'warning',
      subjectRef: 'GET /api/tags',
      message: 'list_tags is disabled: .glirastes/tool-policy.json allows the roles ["guest"], the code (x-glirastes-roles) allows ["tag.read"], and no role is in both.',
    })]);
    expect(disjoint[0]!.nextAction).toContain('tool-policy.json');
    expect(result.tools!.find((tool) => tool.stableKey === 'GET /api/tags')!.findings.map((finding) => finding.code)).toContain('policy-roles-disjoint');
    expect(formatToolsHuman(result)).toContain('  - GET /api/tags  policy-roles-disjoint: list_tags is disabled');
    expect(buildResolveWorklist(result).items.find((item) => item.code === 'policy-roles-disjoint')).toMatchObject({
      tool: 'list_tags',
      stableKey: 'GET /api/tags',
      owner: 'developer',
      target: { kind: 'developer', command: 'glirastes tools policy show list_tags' },
    });
    // The committed report carries code and subject only, never the role names of the message.
    const report = JSON.parse(result.outputs[TOOLS_PATHS.report]!) as { findings: Array<Record<string, string>> };
    expect(report.findings.filter((finding) => finding.code === 'policy-roles-disjoint')).toEqual([
      { code: 'policy-roles-disjoint', severity: 'warning', subjectRef: 'GET /api/tags', nextAction: disjoint[0]!.nextAction },
    ]);

    // The runtime overlay intersects the generated policy again: a Platform decision can only narrow.
    const local = artifactOf(result).tools.map((tool) => ({
      toolId: tool.toolId,
      enabled: tool.enabled,
      riskClass: tool.riskClass,
      requiresApproval: tool.requiresApproval,
      allowedRoles: tool.allowedRoles ?? [],
    }));
    const create = tools.get('POST /api/tags')!.toolId;
    const overlaid = (allowedRoles: string[]) => applyPolicyOverlay(local, [{ toolId: create, allowedRoles }])
      .policies.find((policy) => policy.toolId === create)!;
    expect(overlaid(['tag.write', 'admin'])).toMatchObject({ enabled: true, allowedRoles: ['tag.write'] });
    expect(overlaid(['admin'])).toMatchObject({ enabled: false, allowedRoles: [] });
    expect(overlaid([])).toMatchObject({ enabled: true, allowedRoles: ['tag.write'] });
  }, 60_000);

  it('keeps policy, accepted risk and toolId across a rename: they are keyed on METHOD + path', async () => {
    const spec = await optInSpec();
    delete spec.paths['/api/tags/{tagId}']!.patch!['x-glirastes-name'];
    const policy = {
      schemaVersion: 1,
      tools: { 'PATCH /api/tags/:tagId': { requiresApproval: true, allowedRoles: ['tag.write', 'admin'], reason: 'reviewed' } },
      acceptedRisk: {} as Record<string, unknown>,
    };
    const app = await optInApp({ spec, policy });
    const before = await refresh(app);
    const derived = before.tools!.find((tool) => tool.stableKey === 'PATCH /api/tags/:tagId')!;
    expect(derived.definitionId).toBe('tags.update');
    policy.acceptedRisk['PATCH /api/tags/:tagId'] = { riskClass: derived.riskClass, toolId: derived.toolId };
    await app.write('.glirastes/tool-policy.json', JSON.stringify(policy));
    expect((await refresh(app)).findings.map((finding) => finding.code)).not.toContain('policy-entry-orphaned');

    // The previous inventory holds tags.update; the explicit name wins anyway, without --adopt.
    spec.paths['/api/tags/{tagId}']!.patch!['x-glirastes-name'] = 'update_tag';
    await app.write('openapi.json', JSON.stringify(spec));
    const renamed = await refresh(app);
    const tool = renamed.tools!.find((candidate) => candidate.stableKey === 'PATCH /api/tags/:tagId')!;
    expect(tool).toMatchObject({ definitionId: 'update_tag', toolId: derived.toolId, requiresApproval: true, localPolicy: true });
    expect(candidates(renamed).get('PATCH /api/tags/:tagId')).toMatchObject({
      name: 'update_tag', allowedRoles: ['tag.write'], provenance: { policyOrigin: { requiresApproval: 'local-policy' } },
    });
    expect(renamed.findings.map((finding) => finding.code)).not.toContain('policy-entry-orphaned');
    expect(renamed.changes.removed).toEqual([]);
    expect(renamed.changes.changed).toEqual([derived.toolId]);

    // Removing the extension later keeps the name the inventory now holds (sticky), not the derived one.
    delete spec.paths['/api/tags/{tagId}']!.patch!['x-glirastes-name'];
    await app.write('openapi.json', JSON.stringify(spec));
    const removed = await refresh(app);
    expect(removed.tools!.find((candidate) => candidate.stableKey === 'PATCH /api/tags/:tagId')).toMatchObject({
      definitionId: 'update_tag', toolId: derived.toolId,
    });
    // The kept name still takes its label from the route: the signal is the source, not the extension being present.
    expect(candidates(renamed).get('PATCH /api/tags/:tagId')?.presentation?.singular).toBe('Tags ändern');
    expect(candidates(removed).get('PATCH /api/tags/:tagId')?.presentation?.singular).toBe('Tags ändern');
  }, 60_000);
});

describe('an x-glirastes-name that takes the name of another tool', () => {
  it('warns once, re-points name-keyed tool-semantics.json entries and settles on the next refresh', async () => {
    const spec = await optInSpec();
    delete spec.paths['/api/tags/{tagId}']!.patch!['x-glirastes-name'];
    const app = await optInApp({ spec });
    await app.write(TOOLS_PATHS.semantics, JSON.stringify({
      schemaVersion: 1,
      tools: [{ name: 'tags.update', usageHints: ['Use it to rename a tag.'] }],
    }));
    const before = await refresh(app);
    expect(before.findings.map((finding) => finding.code)).not.toContain('definition-id-reassigned');
    expect(candidates(before).get('PATCH /api/tags/:tagId')).toMatchObject({ name: 'tags.update', usageHints: ['Use it to rename a tag.'] });

    // The delete operation now claims the name the update operation holds.
    spec.paths['/api/tags/{tagId}']!.delete!['x-glirastes-name'] = 'tags.update';
    await app.write('openapi.json', JSON.stringify(spec));
    const frozen = await runToolsPipelineWith({ root: app.root, mode: 'frozen', keepGoing: true }, { now: NOW });
    const taken = await refresh(app);
    for (const result of [frozen, taken]) {
      expect(result.findings.filter((finding) => finding.code === 'definition-id-reassigned')).toEqual([expect.objectContaining({
        severity: 'warning',
        subjectRef: 'DELETE /api/tags/:tagId',
        message: 'x-glirastes-name tags.update on DELETE /api/tags/:tagId was the name of PATCH /api/tags/:tagId, which is now tags.updatePatch.',
      })]);
    }
    // Who gets the name is unchanged; the entry matched by name follows the name, not the operation.
    expect(candidates(taken).get('DELETE /api/tags/:tagId')).toMatchObject({ name: 'tags.update', usageHints: ['Use it to rename a tag.'] });
    expect(candidates(taken).get('PATCH /api/tags/:tagId')?.name).toBe('tags.updatePatch');
    expect(candidates(taken).get('PATCH /api/tags/:tagId')?.usageHints).not.toContain('Use it to rename a tag.');

    expect(formatToolsHuman(taken)).toContain('  - DELETE /api/tags/:tagId  definition-id-reassigned: x-glirastes-name tags.update on DELETE /api/tags/:tagId was the name of PATCH /api/tags/:tagId');
    const item = buildResolveWorklist(frozen).items.find((candidate) => candidate.code === 'definition-id-reassigned')!;
    expect(item).toMatchObject({
      tool: 'tags.update', stableKey: 'DELETE /api/tags/:tagId', owner: 'agent', target: { kind: 'app-code', files: ['openapi.json'] },
    });
    expect(item.nextAction).toContain('tool-semantics.json');
    // Relative to the previous inventory, so never part of a committed output.
    expect(taken.outputs[TOOLS_PATHS.report]).not.toContain('definition-id-reassigned');
    expect(taken.outputs[TOOLS_PATHS.setupArtifact]).not.toContain('definition-id-reassigned');

    const settled = await refresh(app);
    expect(settled.wrote).toBe(false);
    expect(settled.findings.map((finding) => finding.code)).not.toContain('definition-id-reassigned');
  }, 60_000);
});

describe('applyCodeRoles', () => {
  const resolved = (allowedRoles?: string[]): EffectiveToolPolicy => resolveToolPolicy({
    toolId: '019fb007-0000-7000-8000-0000000000b1',
    defaults: deriveToolPolicyDefaults({ executionKind: 'endpoint', method: 'PATCH', path: '/api/tags/:id', definitionId: 'update_tag' }),
    codeEnabled: true,
    ...(allowedRoles ? { local: { allowedRoles } } : {}),
  }).effective;

  it('leaves the policy unchanged without code roles', () => {
    expect(applyCodeRoles(resolved(['a']), undefined)).toEqual(resolved(['a']));
    expect(applyCodeRoles(resolved(), [])).toEqual(resolved());
  });

  it.each([
    [undefined, ['b', 'a', 'a'], true, ['a', 'b'], 'code-default', 'code-default'],
    [['a', 'b', 'c'], ['a', 'b'], true, ['a', 'b'], 'code-default', 'code-default'],
    [['a'], ['a', 'b'], true, ['a'], 'local-policy', 'code-default'],
    [['c'], ['a', 'b'], false, [], 'local-policy', 'local-policy'],
  ] as const)('local %j with code %j: enabled %s, roles %j (%s)', (local, code, enabled, roles, rolesOrigin, enabledOrigin) => {
    const effective = applyCodeRoles(resolved(local ? [...local] : undefined), code);
    expect(effective).toMatchObject({ enabled, allowedRoles: roles, origin: { allowedRoles: rolesOrigin, enabled: enabledOrigin } });
    // Exactly the disjoint case is reported.
    const finding = disjointCodeRolesFinding(
      { stableKey: 'PATCH /api/tags/:id', definitionId: 'update_tag' }, resolved(local ? [...local] : undefined), code,
    );
    expect(finding?.code).toBe(enabled ? undefined : 'policy-roles-disjoint');
  });

  it.each([
    ['tool-policy.json', { codeEnabled: true, local: { enabled: false, allowedRoles: ['c'] } }],
    ['the code', { codeEnabled: false, local: { allowedRoles: ['c'] } }],
  ] as const)('reports no disjoint roles for a tool %s already disabled', (_by, input) => {
    const disabled = resolveToolPolicy({
      toolId: '019fb007-0000-7000-8000-0000000000b1',
      defaults: deriveToolPolicyDefaults({ executionKind: 'endpoint', method: 'PATCH', path: '/api/tags/:id', definitionId: 'update_tag' }),
      codeEnabled: input.codeEnabled,
      local: { ...input.local, allowedRoles: [...input.local.allowedRoles] },
    }).effective;
    expect(disabled.enabled).toBe(false);
    const execution = { stableKey: 'PATCH /api/tags/:id', definitionId: 'update_tag' };
    // The roles are disjoint, but they are not what disables the tool.
    expect(disjointCodeRolesFinding(execution, disabled, ['a', 'b'])).toBeUndefined();
    expect(applyCodeRoles(disabled, ['a', 'b'])).toMatchObject({ enabled: false, origin: { enabled: disabled.origin.enabled } });
  });

  it('reports nothing without code roles', () => {
    const execution = { stableKey: 'PATCH /api/tags/:id', definitionId: 'update_tag' };
    expect(disjointCodeRolesFinding(execution, resolved(['a']), undefined)).toBeUndefined();
    expect(disjointCodeRolesFinding(execution, resolved(['a']), [])).toBeUndefined();
  });
});
