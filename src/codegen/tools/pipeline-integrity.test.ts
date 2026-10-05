import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { DEFAULT_GENERATED_MODULE, TOOLS_PATHS } from './config.js';
import { runToolsPipeline, runToolsPipelineWith, ToolsPipelineFailure } from './pipeline.js';
import type { SchemaProbe } from './schema-probe.js';
import type { ToolSource } from './types.js';

afterEach(removeAppFixtures);

const ROUTE = 'src/app/api/tasks/route.ts';
const ROUTE_SOURCE = "import { createTask } from './schemas';\n"
  + 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET() {\n  await getSession();\n  return Response.json({ tasks: [] as string[] });\n}\n'
  + 'export async function POST(request: Request) {\n  await getSession();\n'
  + '  const input = createTask.parse(await request.json());\n  return Response.json({ id: input.title });\n}\n';

async function refreshedApp(): Promise<AppFixture> {
  const fixture = await createAppFixture({
    'src/app/api/tasks/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() }).strict();\n",
    [ROUTE]: ROUTE_SOURCE,
  });
  await runToolsPipeline({ root: fixture.root, mode: 'write' });
  return fixture;
}

const forbiddenProbe: SchemaProbe = {
  probe: () => {
    throw new Error('integrity mode must not probe schema modules');
  },
};
const forbiddenSource: ToolSource = {
  kind: 'next-app',
  observe: () => {
    throw new Error('integrity mode must not observe sources');
  },
};

async function brokenSubjects(fixture: AppFixture): Promise<string[]> {
  const outcome = await runToolsPipelineWith(
    { root: fixture.root, mode: 'integrity' },
    { probe: forbiddenProbe, sources: [forbiddenSource] },
  ).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  return (outcome as ToolsPipelineFailure).result.findings
    .filter((finding) => finding.code === 'integrity-chain-broken' || finding.code === 'tool-output-invalid')
    .map((finding) => `${finding.code}:${finding.subjectRef}`);
}

describe('runToolsPipeline (integrity)', () => {
  it('verifies the committed chain without observing or probing anything', async () => {
    const fixture = await refreshedApp();
    const result = await runToolsPipelineWith(
      { root: fixture.root, mode: 'integrity' },
      { probe: forbiddenProbe, sources: [forbiddenSource] },
    );
    expect(result).toMatchObject({ mode: 'integrity', wrote: false, driftPaths: [] });
    expect(Object.keys(result.outputs).sort()).toEqual([
      TOOLS_PATHS.runtimeManifest, TOOLS_PATHS.promptManifest, TOOLS_PATHS.receipt, DEFAULT_GENERATED_MODULE,
    ].sort());
  }, 120_000);

  it('ignores and keeps a leftover previous setup artifact from glirastes setup', async () => {
    const fixture = await refreshedApp();
    const leftover = '{"not":"an artifact"}\n';
    await fixture.write(TOOLS_PATHS.previousSetupArtifact, leftover);
    const result = await runToolsPipelineWith(
      { root: fixture.root, mode: 'integrity' },
      { probe: forbiddenProbe, sources: [forbiddenSource] },
    );
    expect(result).toMatchObject({ wrote: false, driftPaths: [] });
    expect(await fixture.read(TOOLS_PATHS.previousSetupArtifact)).toBe(leftover);
  }, 120_000);

  it('keeps verifying a managed receipt as managed', async () => {
    const fixture = await createAppFixture({
      'src/app/api/tasks/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() }).strict();\n",
      [ROUTE]: ROUTE_SOURCE,
      [TOOLS_PATHS.receipt]: '{"mode":"managed"}\n',
    });
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.receipt))).toMatchObject({ mode: 'managed' });
    const result = await runToolsPipelineWith(
      { root: fixture.root, mode: 'integrity' },
      { probe: forbiddenProbe, sources: [forbiddenSource] },
    );
    expect(result).toMatchObject({ wrote: false, driftPaths: [] });
  }, 120_000);

  it.each([
    ['the generated module', DEFAULT_GENERATED_MODULE, (text: string) => `${text}export const injected = true;\n`, `integrity-chain-broken:${DEFAULT_GENERATED_MODULE}`],
    ['the runtime manifest', TOOLS_PATHS.runtimeManifest, (text: string) => text.replace('"policyDigest": "sha256:', '"policyDigest": "sha256:X'), `integrity-chain-broken:${TOOLS_PATHS.runtimeManifest}`],
    ['an approval flag in the artifact', TOOLS_PATHS.setupArtifact, (text: string) => text.replace('"requiresApproval": true', '"requiresApproval": false'), `integrity-chain-broken:${TOOLS_PATHS.runtimeManifest}`],
    ['the receipt', TOOLS_PATHS.receipt, (text: string) => text.replace('"toolCount": 2', '"toolCount": 3'), `integrity-chain-broken:${TOOLS_PATHS.receipt}`],
    ['the route source', ROUTE, (text: string) => `${text}// edited after refresh\n`, `integrity-chain-broken:${TOOLS_PATHS.inventory}`],
  ])('detects a manipulated %s', async (_label, path, edit, expected) => {
    const fixture = await refreshedApp();
    const original = await fixture.read(path);
    const edited = edit(original);
    expect(edited).not.toBe(original);
    await fixture.write(path, edited);
    expect(await brokenSubjects(fixture)).toContain(expected);
  }, 120_000);

  it('reports missing generated files as invalid outputs', async () => {
    const fixture = await refreshedApp();
    await fixture.remove(TOOLS_PATHS.contracts);
    expect(await brokenSubjects(fixture)).toEqual([`tool-output-invalid:${TOOLS_PATHS.contracts}`]);
  }, 120_000);
});
