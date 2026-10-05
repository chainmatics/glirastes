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
import { runToolsPipeline, runToolsPipelineWith, ToolsPipelineFailure } from './pipeline.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import type { ToolSource } from './types.js';

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
