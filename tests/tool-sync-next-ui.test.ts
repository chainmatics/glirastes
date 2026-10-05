import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineResult,
} from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

const REPORTS_PAGE = 'export default function ReportsPage() {\n'
  + '  return <section data-testid="native-ui"><h1>Reports</h1></section>;\n}\n';
const OVERVIEW_FILTERS = "import { defineQueryFilters } from 'glirastes/browser';\n\n"
  + "export const overviewFilters = defineQueryFilters({\n  path: '/overview',\n  filters: { range: ['week', 'month'] },\n});\n";

async function artifactOf(root: string): Promise<AppSetupArtifact> {
  return AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
}

function toolNamed(artifact: AppSetupArtifact, name: string): AppSetupArtifact['tools'][number] {
  const tool = artifact.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

/** `glirastes tools check`: frozen refresh that must fail with a named drift finding. */
async function failingCheck(root: string): Promise<ToolsPipelineResult> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const { result } = outcome as ToolsPipelineFailure;
  expect(result.wrote).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'tool-outputs-drift', subjectRef: '.glirastes/foundation-execution-inventory.json' }),
  ]));
  return result;
}

async function passingCheck(root: string): Promise<void> {
  expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
}

/** Boots a deployment copy of the committed outputs and returns a turn in Alice's session. */
async function deployedTurn(root: string) {
  const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
  expect(app.disabled).toEqual([]);
  return app.turn({ cookie: `session=${app.createSession(principal())}` });
}

function hrefOf(result: unknown): unknown {
  return (result as { uiAction?: { payload?: { href?: unknown } } }).uiAction?.payload?.href;
}

describe('Next navigation change corpus', () => {
  it('adds a page: the same navigation tool offers it at once, without confirmation', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await mkdir(join(root, 'src/app/(app)/reports'), { recursive: true });
    await writeFile(join(root, 'src/app/(app)/reports/page.jsx'), REPORTS_PAGE);

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes).toMatchObject({ added: [], changed: [before.toolId], removed: [] });
    const after = toolNamed(await artifactOf(root), 'ui.navigate');
    expect(after).toMatchObject({
      toolId: before.toolId, operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after.description).toContain('/reports');
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(await turn.guard.resolveApproval({ toolName: 'ui_navigate', input: { destination: '/reports' } })).toBe(false);
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/reports' }))).toBe('/reports');
  }, 240_000);

  it('changes a page path: the old destination is refused, the new one works', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await cp(join(root, 'src/app/(app)/overview'), join(root, 'src/app/(app)/insights'), { recursive: true });
    await rm(join(root, 'src/app/(app)/overview'), { recursive: true });

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    expect(toolNamed(await artifactOf(root), 'ui.navigate').toolId).toBe(before.toolId);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/insights' }))).toBe('/insights');
  }, 240_000);

  it('removes pages: a removed destination is refused, and without pages the tool is tombstoned', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const navigateId = toolNamed(await artifactOf(root), 'ui.navigate').toolId;
    const highlightId = toolNamed(await artifactOf(root), 'ui.tasks.highlight').toolId;
    await rm(join(root, 'src/app/(app)/overview/page.jsx'));

    expect((await failingCheck(root)).changes.changed).toEqual([navigateId]);
    await runToolsPipeline({ root, mode: 'write' });
    await passingCheck(root);
    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/tasks' }))).toBe('/tasks');

    // The tasks page also registered the only tasks.highlight handler, so that tool goes too.
    await rm(join(root, 'src/app/(app)/tasks/page.jsx'));
    const removed = [navigateId, highlightId].sort();
    expect([...(await failingCheck(root)).changes.removed].sort()).toEqual(removed);
    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect([...refreshed.changes.removed].sort()).toEqual(removed);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ toolId: navigateId, stableKey: 'UI navigate' }),
        expect.objectContaining({ toolId: highlightId, stableKey: 'UI action tasks.highlight' }),
      ]));
    await passingCheck(root);
    const after = await deployedTurn(root);
    expect(Object.keys(after.registry)).not.toContain('ui_navigate');
    await expect(after.guard.beforeToolCall({ toolName: 'ui_navigate', input: { destination: '/tasks' } }))
      .rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});

describe('Next filter change corpus', () => {
  it('adds a filter: a new tool, active at once with defaults and no plan confirmation', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    await writeFile(join(root, 'src/overview-filters.js'), OVERVIEW_FILTERS);

    expect((await failingCheck(root)).changes.added).toHaveLength(1);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(1);
    const after = await artifactOf(root);
    const filter = toolNamed(after, 'ui.filter.overview');
    expect(refreshed.changes.added).toEqual([filter.toolId]);
    expect(filter).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'glirastes.navigate', operationGroup: 'ui',
      riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(compareArtifacts(before, after).filter((change) => change.toolId === filter.toolId)).toEqual([
      { toolId: filter.toolId, classification: 'added', fields: ['toolId'], requiresConfirmation: false },
    ]);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(hrefOf(await turn.execute('ui_filter_overview', { range: 'week' }))).toBe('/overview?range=week');
    await expect(turn.execute('ui_filter_overview', { range: 'year' })).rejects.toThrow('Input does not match');
  }, 240_000);

  it('changes a filter domain: same identity, the new value works after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.filter.tasks');
    await replaceIn(root, 'src/task-filters.js', "status: ['open', 'done']", "status: ['open', 'done', 'blocked']");

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = toolNamed(await artifactOf(root), 'ui.filter.tasks');
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(hrefOf(await turn.execute('ui_filter_tasks', { status: 'blocked' }))).toBe('/tasks?status=blocked');
  }, 240_000);

  it('removes a filter: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const filterId = toolNamed(await artifactOf(root), 'ui.filter.tasks').toolId;
    await replaceIn(root, 'src/task-filters.js', "filters: { status: ['open', 'done'] }", 'filters: {}');

    expect((await failingCheck(root)).changes.removed).toEqual([filterId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([filterId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: filterId, stableKey: 'UI filter /tasks' })]);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(Object.keys(turn.registry)).not.toContain('ui_filter_tasks');
    await expect(turn.guard.beforeToolCall({ toolName: 'ui_filter_tasks', input: { status: 'open' } }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('ui_filter_tasks', { status: 'open' })).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});
