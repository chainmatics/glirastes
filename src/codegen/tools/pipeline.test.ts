import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCurrentSetupManifests } from '../../cli/commands/current-setup-manifests.js';
import { createDoctorReport } from '../../cli/commands/doctor.js';
import { createSetupPlan } from '../../cli/commands/setup-plan.js';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { FoundationExecutionInventorySchema } from '../execution-inventory.js';
import { canonicalJson } from './canonical.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT, type AppFixture } from './__tests__/app-fixture.js';
import { DEFAULT_GENERATED_MODULE, TOOLS_PATHS } from './config.js';
import { MAX_FILTER_KEYS, ToolContractsFileSchema } from './files.js';
import { nextActionFor } from './findings.js';
import { runToolsPipeline, runToolsPipelineWith, ToolsPipelineFailure } from './pipeline.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { uiObservation } from './sources/ui-tools.js';
import type { ToolSource } from './types.js';
import { buildResolveWorklist } from './worklist.js';

const outsideDirs: string[] = [];
afterEach(async () => {
  await removeAppFixtures();
  for (const directory of outsideDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n";
const SCHEMAS = "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n";
const GET_HANDLER = 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n";
const POST_HANDLER = 'export async function POST(request: Request) {\n  await getSession(request);\n'
  + '  const input = createTask.parse(await request.json());\n'
  + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n";
const IMPORTS = "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n";
const OUTPUT_PATHS = [
  TOOLS_PATHS.inventory, TOOLS_PATHS.tombstones, TOOLS_PATHS.contracts, TOOLS_PATHS.report,
  TOOLS_PATHS.setupArtifact, TOOLS_PATHS.runtimeManifest, TOOLS_PATHS.promptManifest, TOOLS_PATHS.receipt,
  DEFAULT_GENERATED_MODULE,
];

async function app(): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/lib/session.ts': SESSION,
    'src/lib/schemas.ts': SCHEMAS,
    'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
  });
}

async function snapshot(fixture: AppFixture): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(OUTPUT_PATHS.map(async (path) => [path, await fixture.read(path)] as const)));
}

async function artifactOf(fixture: AppFixture) {
  return AppSetupArtifactSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)));
}

async function failure(promise: Promise<unknown>): Promise<ToolsPipelineFailure> {
  const outcome = await promise.then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  return outcome as ToolsPipelineFailure;
}

describe('runToolsPipeline (write and frozen)', () => {
  it('writes all outputs consistently with setup, doctor and the policy defaults', async () => {
    const fixture = await app();
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.wrote).toBe(true);
    expect(result.changes.added).toHaveLength(2);
    expect(Object.keys(result.outputs).sort()).toEqual([...OUTPUT_PATHS].sort());
    const files = await snapshot(fixture);
    expect(files).toEqual(result.outputs);
    const artifact = await artifactOf(fixture);
    expect(artifact.tools.map((tool) => [tool.method, tool.riskClass, tool.requiresApproval, tool.enabled]).sort())
      .toEqual([['GET', 'safe-read', false, true], ['POST', 'write', true, true]]);
    const rendered = await renderCurrentSetupManifests({ rootDir: fixture.root, managed: false });
    expect(rendered.runtimeContent).toBe(files[TOOLS_PATHS.runtimeManifest]);
    expect(JSON.parse(rendered.runtimeContent)).toHaveProperty('policyDigest');
    const receipt = JSON.parse(files[TOOLS_PATHS.receipt]!) as { planDigest: string; runtimeDigest: string };
    expect(receipt.planDigest).toBe((await createSetupPlan({ rootDir: fixture.root })).planDigest);
    expect(receipt.runtimeDigest).toBe(rendered.runtimeDigest);
  }, 120_000);

  it('is byte-identical on the next run and passes the frozen check', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const first = await snapshot(fixture);
    const again = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(again.wrote).toBe(false);
    expect(again.driftPaths).toEqual([]);
    expect(await snapshot(fixture)).toEqual(first);
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
    expect(frozen.outputs).toEqual(first);
  }, 120_000);

  it('keeps change-relative findings out of the outputs after a risk raise', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    await fixture.write('src/app/api/tasks/route.ts', "import { execFile } from 'node:child_process';\n"
      + `${IMPORTS}${GET_HANDLER}${POST_HANDLER.replace('  await getSession(request);\n', "  await getSession(request);\n  execFile('true');\n")}`);
    const raised = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(raised.findings.filter((finding) => finding.code === 'risk-raised').map((finding) => finding.subjectRef))
      .toEqual(['POST /api/tasks']);
    const post = (await artifactOf(fixture)).tools.find((tool) => tool.method === 'POST');
    expect(post).toMatchObject({ riskClass: 'external', requiresApproval: true });
    expect(await fixture.read(TOOLS_PATHS.report)).not.toContain('risk-raised');
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
  }, 120_000);

  it('reports drift in frozen mode with a named finding and writes nothing', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = await snapshot(fixture);
    await fixture.write('src/app/api/notes/route.ts', `${IMPORTS}${GET_HANDLER}`);
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'frozen' }));
    expect(error.code).toBe('E-TOOLS-010');
    expect(error.result.changes.added).toHaveLength(1);
    expect(error.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tool-outputs-drift', severity: 'error', subjectRef: TOOLS_PATHS.inventory }),
    ]));
    expect(await snapshot(fixture)).toEqual(before);
  }, 120_000);

  it('writes nothing when enumeration is incomplete or the policy is invalid', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = await snapshot(fixture);
    await fixture.write('src/app/api/broken/route.ts', "export * from './handlers';\n");
    const incomplete = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(incomplete.result.wrote).toBe(false);
    expect(incomplete.result.findings.map((finding) => finding.code)).toContain('E-INVENTORY-011');
    const kept = await runToolsPipeline({ root: fixture.root, mode: 'write', keepGoing: true });
    expect(kept.wrote).toBe(false);
    expect(await snapshot(fixture)).toEqual(before);
    await fixture.remove('src/app/api/broken');
    await fixture.write(TOOLS_PATHS.policy, '{ "schemaVersion": 1, "tools": { "GET /api/tasks": { "enabled": "nope" } } }');
    const invalid = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(invalid.result.findings.map((finding) => finding.code)).toContain('E-POLICY-001');
    expect(await snapshot(fixture)).toEqual(before);
  }, 120_000);

  it('keeps the identity of a known tool that becomes unresolved and disables it', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const postId = (await artifactOf(fixture)).tools.find((tool) => tool.method === 'POST')!.toolId;
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}declare function save(value: unknown): Promise<{ id: string }>;\n${GET_HANDLER}`
      + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
      + '  return Response.json(await save(body));\n}\n');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.changed).toContain(postId);
    const post = (await artifactOf(fixture)).tools.find((tool) => tool.toolId === postId);
    expect(post).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(module.slice(module.indexOf('export const toolCatalog'))).not.toContain(postId);
  }, 120_000);

  it('tombstones removed tools and adopts an existing inventory', async () => {
    const fixture = await app();
    await fixture.write('pilot/inventory.json', canonicalJson({
      schemaVersion: 2,
      targetAppKey: 'tool-fixture',
      executions: [{
        toolId: '019fb007-0000-7000-8000-0000000000e1', definitionId: 'tasks.search', stableKey: 'GET /api/tasks',
        executionKind: 'endpoint', sourceFile: 'src/app/api/tasks/route.ts', method: 'GET', path: '/api/tasks',
        sourceFingerprint: `sha256:${'F'.repeat(43)}`, inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
        outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
      }],
    }));
    const adopted = await runToolsPipeline({ root: fixture.root, mode: 'write', adoptInventoryPath: 'pilot/inventory.json' });
    expect(adopted.changes.changed).toEqual(['019fb007-0000-7000-8000-0000000000e1']);
    const inventory = FoundationExecutionInventorySchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.inventory)));
    expect(inventory.executions.find((entry) => entry.stableKey === 'GET /api/tasks'))
      .toMatchObject({ toolId: '019fb007-0000-7000-8000-0000000000e1', definitionId: 'tasks.search' });
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}${POST_HANDLER}`);
    const removed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(removed.changes.removed).toEqual(['019fb007-0000-7000-8000-0000000000e1']);
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.tombstones))).toMatchObject({
      appId: FIXTURE_APP_ID,
      tombstones: [{ toolId: '019fb007-0000-7000-8000-0000000000e1', stableKey: 'GET /api/tasks' }],
    });
  }, 120_000);

  it('refuses to write through a linked output folder', async () => {
    const fixture = await app();
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    outsideDirs.push(outside);
    await mkdir(fixture.path('.glirastes'), { recursive: true });
    await symlink(outside, fixture.path('.glirastes/build'), 'dir');
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(error.result.findings.map((finding) => finding.code)).toContain('output-path-linked');
    expect(await readdir(outside)).toEqual([]);
    await expect(readFile(fixture.path(TOOLS_PATHS.inventory))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

describe('runToolsPipeline (committed outputs only)', () => {
  it('never reads a leftover previous setup artifact and removes it when it writes', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = await snapshot(fixture);
    await fixture.write(TOOLS_PATHS.previousSetupArtifact, 'not json, never read\n');
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
    expect(await fixture.read(TOOLS_PATHS.previousSetupArtifact)).toBe('not json, never read\n');
    const refreshed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(refreshed).toMatchObject({ wrote: false, driftPaths: [] });
    await expect(fixture.read(TOOLS_PATHS.previousSetupArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshot(fixture)).toEqual(before);
  }, 120_000);

  it('keeps the receipt independent of the leftover on a first refresh', async () => {
    const fixture = await app();
    await fixture.write(TOOLS_PATHS.previousSetupArtifact, '{}\n');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.wrote).toBe(true);
    await expect(fixture.read(TOOLS_PATHS.previousSetupArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt = JSON.parse(await fixture.read(TOOLS_PATHS.receipt)) as { planDigest: string };
    expect(receipt.planDigest).toBe((await createSetupPlan({ rootDir: fixture.root })).planDigest);
  }, 120_000);

  it('keeps the generated receipt current for doctor when setup leaves a previous artifact again', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const artifact = await artifactOf(fixture);
    const earlier = {
      ...artifact,
      tools: artifact.tools.map((tool) => (tool.method === 'POST'
        ? { ...tool, riskClass: 'safe-read', requiresApproval: false }
        : tool)),
    };
    await fixture.write(TOOLS_PATHS.previousSetupArtifact, `${JSON.stringify(earlier)}\n`);
    const receipt = JSON.parse(await fixture.read(TOOLS_PATHS.receipt)) as { planDigest: string };
    // The file-based plan now compares against the leftover, so only the self-plan matches.
    expect((await createSetupPlan({ rootDir: fixture.root })).planDigest).not.toBe(receipt.planDigest);

    const report = await createDoctorReport({ rootDir: fixture.root, env: {} });

    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'receipt', status: 'pass', code: 'E-SETUP-105' }));
  }, 120_000);

  it('still fails doctor for a receipt digest that is neither the plan nor the self-plan', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const receipt = JSON.parse(await fixture.read(TOOLS_PATHS.receipt)) as Record<string, unknown>;
    await fixture.write(TOOLS_PATHS.receipt, `${JSON.stringify({ ...receipt, planDigest: `sha256:${'A'.repeat(43)}` })}\n`);

    const report = await createDoctorReport({ rootDir: fixture.root, env: {} });

    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'receipt', status: 'fail', code: 'E-SETUP-010' }));
  }, 120_000);

  it('disables a tool whose source reported no contract instead of crashing the module renderer', async () => {
    const fixture = await app();
    const real = createNextEndpointSource();
    const withoutContracts: ToolSource = {
      kind: real.kind,
      observe: async (context) => {
        const observation = await real.observe(context);
        return { ...observation, observations: observation.observations.map(({ contract: _contract, ...tool }) => tool) };
      },
    };
    const result = await runToolsPipelineWith({ root: fixture.root, mode: 'write' }, { sources: [withoutContracts] });
    expect(result.wrote).toBe(true);
    expect(result.findings.filter((finding) => finding.code === 'input-contract-unresolved').map((finding) => finding.subjectRef).sort())
      .toEqual(['GET /api/tasks', 'POST /api/tasks']);
    expect((await artifactOf(fixture)).tools.map((tool) => [tool.enabled, tool.operationGroup]))
      .toEqual([[false, 'needs_attention'], [false, 'needs_attention']]);
  }, 120_000);
});

describe('runToolsPipeline (policy findings)', () => {
  it('points an unpinned relaxation to the reviewed pin', async () => {
    const fixture = await app();
    await fixture.write(TOOLS_PATHS.policy, JSON.stringify({ schemaVersion: 1, tools: { 'POST /api/tasks': { requiresApproval: false } } }));
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    const finding = error.result.findings.find((entry) => entry.code === 'E-POLICY-002');
    expect(finding).toMatchObject({ severity: 'error', subjectRef: 'POST /api/tasks' });
    expect(finding?.nextAction).toContain('reviewed pin');
    await expect(fixture.read(TOOLS_PATHS.inventory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

describe('capability report in the committed setup artifact', () => {
  it('reports provenance per tool and every exclusion', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/auth/login/route.ts', 'export async function POST() {\n  return Response.json({});\n}\n');
    await fixture.write('.glirastes/tool-policy.json', JSON.stringify({
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { description: 'Lists your tasks by status.' } },
      exclude: [{ match: 'DELETE /api/**', reason: 'no deletes from chat' }],
      acceptedRisk: {},
    }));
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const artifact = await artifactOf(fixture);
    const byMethod = new Map(artifact.tools.map((tool) => [tool.method, tool] as const));
    expect(byMethod.get('GET')?.provenance).toEqual({
      policyOrigin: {
        enabled: 'code-default', requiresApproval: 'code-default', riskClass: 'code-default',
        allowedRoles: 'code-default', description: 'local-policy',
      },
      contractSource: 'derived',
      descriptionSource: 'human',
      schemaSource: 'field-names',
    });
    expect(byMethod.get('POST')?.provenance).toMatchObject({
      contractSource: 'native', descriptionSource: 'template', schemaSource: 'zod',
    });
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);

  it('reports an explicit local confirmation as a local lock, also where the code asks anyway', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.method, tool] as const));
    expect(before.get('POST')).toMatchObject({
      requiresApproval: true,
      provenance: { policyOrigin: { requiresApproval: 'code-default' } },
    });

    await fixture.write(TOOLS_PATHS.policy, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': { requiresApproval: true },
        'POST /api/tasks': { requiresApproval: true, reason: 'keep asking, whatever the dashboard says' },
      },
    }));
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const after = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.method, tool] as const));
    for (const method of ['GET', 'POST'] as const) {
      expect(after.get(method)).toMatchObject({
        requiresApproval: true,
        provenance: { policyOrigin: { requiresApproval: 'local-policy' } },
      });
    }
  }, 120_000);
});

const PAGE = 'export default function Page() { return null; }\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';

describe('runToolsPipeline (navigation)', () => {
  async function pagesApp(): Promise<AppFixture> {
    return createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
      'src/components/glirastes-bridge.tsx': BRIDGE,
    }, { toolsConfig: { sources: ['next-pages'] } });
  }

  it('generates ui.navigate as an active UI tool without confirmation, bound in the module and verified in every mode', async () => {
    const fixture = await pagesApp();
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.added).toHaveLength(1);
    const [tool] = (await artifactOf(fixture)).tools;
    expect(tool).toMatchObject({
      name: 'ui.navigate', modelName: 'ui_navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate',
      operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true,
      description: "Open a page of this app in the user's browser. Destinations: /, /tasks.",
      provenance: { contractSource: 'ui-bridge', descriptionSource: 'code', schemaSource: 'json-schema' },
    });
    const contracts = JSON.parse(await fixture.read(TOOLS_PATHS.contracts)) as {
      tools: Array<{ contract: { uiAction?: unknown } }>;
    };
    expect(contracts.tools[0]?.contract.uiAction).toEqual({ kind: 'navigate' });
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).toContain("import { uiActionToolToTool } from 'glirastes/server';");
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).driftPaths).toEqual([]);
  }, 120_000);

  it('keeps the identity but disables navigation once the bridge is gone', async () => {
    const fixture = await pagesApp();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const toolId = (await artifactOf(fixture)).tools[0]!.toolId;
    await fixture.remove('src/components/glirastes-bridge.tsx');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.unchanged).toEqual([toolId]);
    expect((await artifactOf(fixture)).tools[0]).toMatchObject({ toolId, enabled: false, operationGroup: 'needs_attention' });
    expect(await fixture.read(TOOLS_PATHS.report)).toContain('navigation-bridge-missing');
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('uiActionToolToTool');
  }, 120_000);
});

describe('runToolsPipeline (filters)', () => {
  it('generates one filter tool per view, inheriting the page options of next-pages', async () => {
    const fixture = await createAppFixture({
      'src/app/[locale]/tasks/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
        + "export default function Tasks() { return useSearchParams().get('status'); }\n",
      'src/components/glirastes-bridge.tsx': BRIDGE,
    }, { toolsConfig: { sources: [{ kind: 'next-pages', stripSegments: ['[locale]'] }, 'url-filters'] } });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.added).toHaveLength(2);
    const tools = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.name, tool] as const));
    expect(tools.get('ui.navigate')?.description).toBe("Open a page of this app in the user's browser. Destinations: /tasks.");
    expect(tools.get('ui.filter.tasks')).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'glirastes.navigate', riskClass: 'safe-read', requiresApproval: false, enabled: true,
      description: 'Show the /tasks page with URL filters: status (text).',
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'filter-domain-open', subjectRef: 'UI filter /tasks' }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);

  const wideKeys = (count: number) => Array.from({ length: count }, (_, index) => `k${String(index).padStart(2, '0')}`);

  it('caps the keys of a wide view so the check right after refresh reads what refresh wrote', async () => {
    const keys = wideKeys(MAX_FILTER_KEYS + 1);
    const fixture = await createAppFixture({
      'src/views.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
        + `export const wide = defineQueryFilters({ path: '/wide', filters: { ${keys.map((key) => `${key}: 'string'`).join(', ')} } });\n`,
      'src/components/glirastes-bridge.tsx': BRIDGE,
    }, { toolsConfig: { sources: ['url-filters'] } });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.wrote).toBe(true);
    expect(result.changes.added).toHaveLength(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'filter-keys-capped', severity: 'warning', subjectRef: 'UI filter /wide',
    }));
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    const uiAction = contracts.tools[0]?.contract?.uiAction;
    expect(uiAction?.kind === 'filter' ? uiAction.keys.map((entry) => entry.key) : []).toEqual(keys.slice(0, MAX_FILTER_KEYS));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).findings).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'write' })).wrote).toBe(false);
  }, 120_000);

  it('writes nothing when a rendered output would fail the schema its own reader applies', async () => {
    const keys = wideKeys(MAX_FILTER_KEYS + 1);
    const wide: ToolSource = {
      kind: 'url-filters',
      observe: async () => ({
        observations: [uiObservation({
          stableKey: 'UI filter /wide',
          definitionId: 'ui.filter.wide',
          actionBindingRef: 'glirastes.navigate',
          input: {
            type: 'object',
            properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
            additionalProperties: false,
          },
          uiAction: { kind: 'filter', destination: '/wide', keys: keys.map((key) => ({ key })) },
          params: { path: [], query: keys, body: [] },
          facts: { keys },
          findings: [],
        })],
        findings: [],
        complete: true,
        excluded: [],
      }),
    };
    const fixture = await createAppFixture({ 'src/components/glirastes-bridge.tsx': BRIDGE });
    for (const mode of ['write', 'frozen'] as const) {
      const error = await failure(runToolsPipelineWith({ root: fixture.root, mode }, { sources: [wide] }));
      const invalid = error.result.findings.filter((finding) => finding.code === 'generated-output-invalid');
      expect(invalid).toEqual([expect.objectContaining({ severity: 'error', subjectRef: TOOLS_PATHS.contracts })]);
      expect(invalid[0]?.message).toContain('UI filter /wide');
      expect(invalid[0]?.message).toContain('uiAction.keys');
      expect(invalid[0]?.nextAction).toBe(nextActionFor('generated-output-invalid'));
      expect(invalid[0]?.nextAction).not.toBe(nextActionFor('no-such-code'));
      expect(error.result.outputs).toEqual({});
    }
    for (const path of OUTPUT_PATHS) {
      await expect(fixture.read(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 120_000);
});

describe('runToolsPipeline (client actions)', () => {
  it('runs read-only client actions directly, confirms writing ones and disables untyped ones', async () => {
    const fixture = await createAppFixture({
      'src/components/task-list.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + 'export function TaskList() {\n'
        + "  useAiClientAction('tasks.highlight', (payload: { taskId: string }) => console.log(payload.taskId));\n"
        + "  useAiClientAction('tasks.archive', async (payload: { taskId: string }) => {\n"
        + "    await fetch(`/api/tasks/${payload.taskId}`, { method: 'DELETE' });\n  });\n"
        + "  useAiClientAction('tasks.select', (payload) => console.log(payload));\n  return null;\n}\n",
    }, { toolsConfig: { sources: ['react-actions'] } });
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const tools = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.name, tool] as const));
    expect(tools.get('ui.tasks.highlight')).toMatchObject({
      operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true, actionBindingRef: 'tasks.highlight',
    });
    expect(tools.get('ui.tasks.archive')).toMatchObject({
      operationGroup: 'ui', riskClass: 'write', requiresApproval: true, enabled: true,
    });
    expect(tools.get('ui.tasks.select')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});

describe('runToolsPipeline (stage-2 semantics)', () => {
  const EXAMPLES = ['Show my tasks', 'Which tasks are still open?', 'List the finished tasks'];

  async function interfaceOf(fixture: AppFixture, stableKey: string): Promise<string> {
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    return contracts.tools.find((entry) => entry.stableKey === stableKey)!.contract!.interfaceDigest;
  }

  it('carries checked synonyms and examples into the contracts file, the module and the tool view', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const interfaceDigest = await interfaceOf(fixture, 'GET /api/tasks');
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [{
        stableKey: 'GET /api/tasks',
        description: 'Lists the caller\'s tasks, optionally by status. Use tasks.create to add one.',
        synonyms: { en: ['to-dos', 'my work'] },
        examples: { en: EXAMPLES },
        exampleCalls: [{ sentence: 'List the finished tasks', input: { status: ['done'] } }],
        origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
        agent: { model: 'claude-code', interfaceDigest },
      }],
    })}\n`);
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const entry = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)))
      .tools.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(entry?.search).toEqual({ synonyms: ['my work', 'to-dos'], examples: [...EXAMPLES].sort() });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(module).toContain('export const toolSearchSemantics = {\n  "tasks_list": {\n    "synonyms": [\n      "my work",');
    const view = result.tools?.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(view).toMatchObject({
      definitionId: 'tasks.list',
      modelName: 'tasks_list',
      route: 'GET /api/tasks',
      files: ['src/app/api/tasks/route.ts', 'src/lib/schemas.ts', 'src/lib/session.ts'],
      interfaceDigest,
      params: { path: [], query: ['status'], body: [] },
      descriptionOrigin: 'agent',
      schemaQuality: 'field-names',
      semantics: { protectedFields: [], hasSynonyms: true, missingExamples: [], stale: false, rejected: false },
    });
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);

  it('ignores a rejected agent entry and keeps a stale one in use until it is renewed', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const interfaceDigest = await interfaceOf(fixture, 'GET /api/tasks');
    const agent = { model: 'codex', interfaceDigest };
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'GET /api/tasks', description: 'Lists tasks by status.', origin: { description: 'agent' }, agent },
        {
          stableKey: 'POST /api/tasks', description: 'Creates a task.', examples: { en: ['Mail bob@corp.example.org', 'b', 'c'] },
          origin: { description: 'agent', examples: 'agent' }, agent,
        },
      ],
    })}\n`);
    const first = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const post = first.tools?.find((tool) => tool.stableKey === 'POST /api/tasks');
    expect(post).toMatchObject({ descriptionOrigin: 'template', semantics: { rejected: true } });
    expect(post?.findings.map((finding) => finding.code)).toContain('resolution-rejected');
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}${GET_HANDLER.replace(
      "searchParams.getAll('status')", "searchParams.getAll('status'), q: searchParams.get('q')",
    )}${POST_HANDLER}`);
    const changed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const get = changed.tools?.find((tool) => tool.stableKey === 'GET /api/tasks');
    expect(get).toMatchObject({ description: 'Lists tasks by status.', descriptionOrigin: 'agent', semantics: { stale: true } });
    expect(get?.findings.map((finding) => [finding.code, finding.severity])).toContainEqual(['semantics-stale', 'warning']);
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.report)).findings).toContainEqual(expect.objectContaining({
      code: 'semantics-stale', subjectRef: 'GET /api/tasks',
    }));
  }, 120_000);

  it('keeps a stale agent entry in use without the example calls the changed interface no longer accepts', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const entry = (stableKey: string, interfaceDigest: string, input: Record<string, unknown>) => ({
      stableKey,
      description: `${stableKey === 'GET /api/tasks' ? 'Lists' : 'Creates'} tasks for the caller.`,
      synonyms: { en: [stableKey === 'GET /api/tasks' ? 'my work' : 'new to-do'] },
      exampleCalls: [{ sentence: 'Do it', input }],
      origin: { description: 'agent', synonyms: 'agent', exampleCalls: 'agent' },
      agent: { model: 'codex', interfaceDigest },
    });
    await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
      schemaVersion: 1,
      tools: [
        entry('GET /api/tasks', await interfaceOf(fixture, 'GET /api/tasks'), { status: ['done'] }),
        entry('POST /api/tasks', await interfaceOf(fixture, 'POST /api/tasks'), { title: 'Buy milk' }),
      ],
    })}\n`);
    const current = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(current.findings.filter((finding) => finding.code === 'resolution-rejected' || finding.code === 'semantics-stale')).toEqual([]);

    // GET drops the status key, POST switches to a schema with one more required key.
    await fixture.write('src/lib/schemas.ts', `${SCHEMAS}export const createRankedTask = z.object({ title: z.string().min(1), rank: z.number() }).strict();\n`);
    await fixture.write('src/app/api/tasks/route.ts', IMPORTS.replace('{ createTask }', '{ createRankedTask }')
      + GET_HANDLER.replace("status: searchParams.getAll('status')", "q: searchParams.get('q')")
      + POST_HANDLER.replace('createTask.parse', 'createRankedTask.parse'));
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.findings.filter((finding) => finding.code === 'resolution-rejected' || finding.code === 'tool-semantics-invalid')).toEqual([]);
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    for (const [stableKey, synonym] of [['GET /api/tasks', 'my work'], ['POST /api/tasks', 'new to-do']] as const) {
      const tool = result.tools?.find((candidate) => candidate.stableKey === stableKey);
      expect(tool).toMatchObject({ descriptionOrigin: 'agent', semantics: { stale: true, rejected: false } });
      expect(tool?.findings.find((finding) => finding.code === 'semantics-stale')?.message)
        .toContain('Example calls left out until then, because the input schema no longer accepts them: 1.');
      expect(contracts.tools.find((candidate) => candidate.stableKey === stableKey)?.search).toEqual({ synonyms: [synonym] });
      expect(module).toContain(JSON.stringify(synonym));
    }
  }, 120_000);
});

describe('runToolsPipeline (orphaned policy entries)', () => {
  it('reports entries for excluded routes and accepted risks without a tool as orphaned', async () => {
    const fixture = await app();
    await fixture.write('src/app/api/internal/sync/route.ts', `${IMPORTS}${POST_HANDLER}`);
    await fixture.write(TOOLS_PATHS.policy, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'POST /api/internal/sync': { enabled: false },
        'POST /api/auth/login': { requiresApproval: true },
        'GET /api/tasks': { description: 'Lists your tasks by status.' },
      },
      exclude: [{ match: 'POST /api/internal/**', reason: 'internal' }],
      acceptedRisk: { 'DELETE /api/gone/:id': { riskClass: 'write', toolId: '019fb007-0000-7000-8000-0000000000e1' } },
    }));
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const orphaned = result.findings.filter((finding) => finding.code === 'policy-entry-orphaned');
    expect(orphaned.map((finding) => [finding.subjectRef, finding.message])).toEqual([
      ['DELETE /api/gone/:id', 'This tool-policy.json acceptedRisk entry matches no tool in the current code.'],
      ['POST /api/auth/login', 'This tool-policy.json tools entry matches no tool in the current code.'],
      ['POST /api/internal/sync', 'This tool-policy.json tools entry has no effect: the route is excluded (internal, policy).'],
    ]);
    expect(orphaned[0]?.nextAction).toContain('glirastes tools policy reset');
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.report)).findings
      .filter((finding: { code: string }) => finding.code === 'policy-entry-orphaned')).toHaveLength(3);
  }, 120_000);
});

describe('runToolsPipeline (app identity)', () => {
  it('refuses to re-key every tool when tools.json changes its app id after a committed refresh', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const config = JSON.parse(await fixture.read(TOOLS_PATHS.config)) as Record<string, unknown>;
    await fixture.write(TOOLS_PATHS.config, JSON.stringify({ ...config, appId: '019fb007-0000-7000-8000-0000000000f9' }));
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(error.result.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['generation-state-invalid', TOOLS_PATHS.tombstones],
      ['prompt-bundle-invalid', TOOLS_PATHS.promptBundle],
    ]);
    expect(error.result.wrote).toBe(false);
  }, 120_000);
});

describe('runToolsPipeline (input schema root)', () => {
  it('disables a tool whose input schema is no object at its root and lists it for the coding agent', async () => {
    const fixture = await app();
    await fixture.write('src/lib/notes.ts', "import { z } from 'zod';\n"
      + 'export const saveNote = z.union([z.object({ text: z.string() }).strict(), z.object({ url: z.string() }).strict()]);\n');
    await fixture.write('src/app/api/notes/route.ts', "import { getSession } from '@/lib/session';\nimport { saveNote } from '@/lib/notes';\n"
      + 'export async function POST(request: Request) {\n  await getSession(request);\n'
      + '  const input = saveNote.parse(await request.json());\n  return Response.json(input, { status: 201 });\n}\n');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const note = result.tools?.find((tool) => tool.stableKey === 'POST /api/notes');
    expect(note).toMatchObject({ enabled: false, contract: { source: 'native' } });
    expect(note?.findings.filter((finding) => finding.severity === 'needs_attention').map((finding) => finding.code))
      .toEqual(['input-schema-not-object']);
    expect((await artifactOf(fixture)).tools.find((tool) => tool.name === 'notes.create'))
      .toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).not.toContain('saveNote');
    expect(buildResolveWorklist(result).items).toContainEqual(expect.objectContaining({
      code: 'input-schema-not-object', tool: 'notes.create', owner: 'agent', target: { kind: 'app-code', files: note!.files },
    }));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
  }, 120_000);
});

describe('runToolsPipeline (MCP endpoint catalog)', () => {
  it('emits the catalog under the names mcp-tool-names.json keeps and re-renders it in integrity mode', async () => {
    const fixture = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/session.ts': SESSION,
      'src/lib/schemas.ts': SCHEMAS,
      'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
    }, { toolsConfig: { emit: { mcpCatalog: true } } });
    await fixture.write(TOOLS_PATHS.mcpToolNames, `${JSON.stringify({
      schemaVersion: 1,
      tools: {
        'POST /api/tasks': [{ id: 'tasks.create', name: 'create_task' }, { id: 'tasks.quickAdd', name: 'quick_add_task' }],
        'GET /api/gone': [{ id: 'gone.list', name: 'list_gone' }],
      },
    })}\n`);
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.findings.filter((finding) => finding.code === 'mcp-tool-names-invalid').map((finding) => finding.subjectRef))
      .toEqual(['GET /api/gone']);
    expect(buildResolveWorklist(result).items).toContainEqual(expect.objectContaining({
      code: 'mcp-tool-names-invalid', owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.mcpToolNames, key: 'tools["GET /api/gone"]' },
    }));
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    expect(contracts.tools.find((tool) => tool.stableKey === 'POST /api/tasks')?.mcp)
      .toEqual([{ id: 'tasks.create', name: 'create_task' }, { id: 'tasks.quickAdd', name: 'quick_add_task' }]);
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    const catalog = module.slice(module.indexOf('export function createMcpEndpointCatalog() {'));
    expect(catalog.match(/"name": "\w+"/g)).toEqual(['"name": "create_task"', '"name": "quick_add_task"', '"name": "tasks_list"']);
    expect(catalog).toContain('"inputSchema": m0.createTask');
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).driftPaths).toEqual([]);
    await fixture.write(TOOLS_PATHS.mcpToolNames, JSON.stringify({ schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'x', name: 'two words' }] } }));
    const invalid = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(invalid.findings.map((finding) => [finding.code, finding.subjectRef])).toContainEqual(['mcp-tool-names-invalid', TOOLS_PATHS.mcpToolNames]);
    expect(await fixture.read(DEFAULT_GENERATED_MODULE)).toContain('"name": "tasks_create"');
  }, 180_000);

  it('refuses kept names and ids that another tool already uses and falls back to the generated ones', async () => {
    const fixture = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/session.ts': SESSION,
      'src/lib/schemas.ts': SCHEMAS,
      'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
    }, { toolsConfig: { emit: { mcpCatalog: true } } });
    const catalogNames = async () => {
      const module = await fixture.read(DEFAULT_GENERATED_MODULE);
      return module.slice(module.indexOf('export function createMcpEndpointCatalog() {')).match(/"(?:id|name)": "[\w.]+"/g);
    };
    const collisions = (result: Awaited<ReturnType<typeof runToolsPipeline>>) => result.findings
      .filter((finding) => finding.code === 'mcp-tool-names-invalid');

    // A kept name that equals the generated name of the other route.
    await fixture.write(TOOLS_PATHS.mcpToolNames, JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'tasks.create', name: 'tasks_list' }] },
    }));
    const byName = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(collisions(byName)).toEqual([expect.objectContaining({
      severity: 'warning',
      subjectRef: 'POST /api/tasks',
      message: expect.stringMatching(/name tasks_list kept for POST \/api\/tasks is also used by GET \/api\/tasks/),
    })]);
    expect(buildResolveWorklist(byName).items).toContainEqual(expect.objectContaining({
      code: 'mcp-tool-names-invalid', owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.mcpToolNames, key: 'tools["POST /api/tasks"]' },
    }));
    expect(await catalogNames()).toEqual(['"id": "tasks.create"', '"name": "tasks_create"', '"id": "tasks.list"', '"name": "tasks_list"']);
    const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
    expect(contracts.tools.map((tool) => [tool.stableKey, tool.mcp])).toEqual(expect.arrayContaining([['POST /api/tasks', undefined]]));
    expect((await runToolsPipeline({ root: fixture.root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root: fixture.root, mode: 'integrity' })).driftPaths).toEqual([]);

    // A kept grant id that equals the contract id of the other route.
    await fixture.write(TOOLS_PATHS.mcpToolNames, JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'tasks.list', name: 'create_task' }] },
    }));
    const byId = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(collisions(byId)).toEqual([expect.objectContaining({
      subjectRef: 'POST /api/tasks',
      message: expect.stringMatching(/id tasks\.list kept for POST \/api\/tasks is also used by GET \/api\/tasks/),
    })]);
    expect(await catalogNames()).toEqual(['"id": "tasks.create"', '"name": "tasks_create"', '"id": "tasks.list"', '"name": "tasks_list"']);

    // Names that stay clear of every other tool are kept and raise nothing.
    await fixture.write(TOOLS_PATHS.mcpToolNames, JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'tasks.add', name: 'add_task' }] },
    }));
    const clean = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(collisions(clean)).toEqual([]);
    expect(await catalogNames()).toEqual(['"id": "tasks.add"', '"name": "add_task"', '"id": "tasks.list"', '"name": "tasks_list"']);
  }, 180_000);

  it('checks the names only when the catalog is emitted and only against enabled endpoint tools', async () => {
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/session.ts': SESSION,
      'src/lib/schemas.ts': SCHEMAS,
      'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
    };
    const names = JSON.stringify({ schemaVersion: 1, tools: { 'POST /api/tasks': [{ id: 'tasks.create', name: 'tasks_list' }] } });
    const off = await createAppFixture(files);
    await off.write(TOOLS_PATHS.mcpToolNames, names);
    const without = await runToolsPipeline({ root: off.root, mode: 'write' });
    expect(without.findings.filter((finding) => finding.code === 'mcp-tool-names-invalid')).toEqual([]);

    const disabled = await createAppFixture(files, { toolsConfig: { emit: { mcpCatalog: true } } });
    await disabled.write(TOOLS_PATHS.mcpToolNames, names);
    await disabled.write(TOOLS_PATHS.policy, JSON.stringify({ schemaVersion: 1, tools: { 'GET /api/tasks': { enabled: false } } }));
    const result = await runToolsPipeline({ root: disabled.root, mode: 'write' });
    expect(result.findings.filter((finding) => finding.code === 'mcp-tool-names-invalid')).toEqual([]);
    const module = await disabled.read(DEFAULT_GENERATED_MODULE);
    expect(module.slice(module.indexOf('export function createMcpEndpointCatalog() {')).match(/"name": "\w+"/g)).toEqual(['"name": "tasks_list"']);
  }, 180_000);
});
