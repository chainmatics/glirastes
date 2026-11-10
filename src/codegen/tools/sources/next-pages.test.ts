import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { jsonSchemaDigest } from '../canonical.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createNextPagesSource } from './next-pages.js';

const outsideDirs: string[] = [];
afterEach(async () => {
  await removeAppFixtures();
  for (const directory of outsideDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const PAGE = 'export default function Page() { return null; }\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';

function context(root: string, exclude: Array<{ match: string; reason: string }> = []): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude, acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

describe('next-pages source', () => {
  it('offers every page as a destination of one navigation tool', async () => {
    const app = await createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
      'src/app/tasks/[taskId]/page.tsx': PAGE,
      'src/app/login/page.tsx': PAGE,
      'src/components/glirastes-bridge.tsx': BRIDGE,
    });
    const observed = await createNextPagesSource().observe(context(app.root));
    const input = {
      type: 'object',
      properties: {
        destination: { type: 'string', enum: ['/', '/tasks', '/tasks/:taskId'] },
        params: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, additionalProperties: false },
      },
      required: ['destination'],
      additionalProperties: false,
    };
    expect(observed).toMatchObject({
      complete: true,
      findings: [],
      excluded: [{ stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' }],
    });
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]).toMatchObject({
      execution: {
        definitionId: 'ui.navigate', stableKey: 'UI navigate', executionKind: 'ui',
        actionBindingRef: 'glirastes.navigate', inputSchemaDigest: jsonSchemaDigest(input),
      },
      contract: { source: 'ui-bridge', input, uiAction: { kind: 'navigate' }, params: { path: ['taskId'], query: [], body: [] } },
      findings: [],
      prose: {
        contractDescription: "Open a page of this app in the user's browser. Destinations: /, /tasks, /tasks/:taskId (needs params.taskId).",
        presentation: { locale: 'en-US', singular: 'Open page', plural: 'Open pages', approval: 'Open a page' },
      },
    });
  }, 60_000);

  it('keeps the tool but needs attention when no navigation bridge is mounted', async () => {
    const app = await createAppFixture({
      'src/app/tasks/page.tsx': PAGE,
      'src/components/fake.tsx': '// useGlirastesNavigationBridge({ push }) is not called here\n',
    });
    const [tool] = (await createNextPagesSource().observe(context(app.root))).observations;
    expect(tool?.contract).toBeDefined();
    expect(tool?.findings).toEqual([expect.objectContaining({
      code: 'navigation-bridge-missing', severity: 'needs_attention', subjectRef: 'UI navigate',
    })]);
  }, 60_000);

  it('describes the destinations in German for a German app', async () => {
    const app = await createAppFixture({ 'app/aufgaben/page.jsx': PAGE }, {
      toolsConfig: { locale: 'de-DE', sources: ['next-pages'] },
    });
    const [tool] = (await createNextPagesSource().observe(context(app.root))).observations;
    expect(tool?.prose).toMatchObject({
      contractDescription: 'Öffnet eine Seite dieser App im Browser des Nutzers. Ziele: /aufgaben.',
      presentation: { locale: 'de-DE', singular: 'Seite öffnen' },
    });
  }, 60_000);

  it('produces nothing for an app without pages and stops on an unreadable page tree', async () => {
    const empty = await createAppFixture({ 'src/app/api/tasks/route.ts': 'export async function GET() {}\n' });
    expect(await createNextPagesSource().observe(context(empty.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
    const linked = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE });
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    outsideDirs.push(outside);
    await symlink(outside, linked.path('src/app/reports'), 'dir');
    expect(await createNextPagesSource().observe(context(linked.root))).toMatchObject({
      complete: false,
      observations: [],
      findings: [{ code: 'E-INVENTORY-011', severity: 'error', subjectRef: 'next-pages' }],
    });
  }, 60_000);
});
