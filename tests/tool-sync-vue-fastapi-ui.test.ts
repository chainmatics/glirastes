import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  pythonReady,
  removeCopiedApps,
  VUE_APP,
} from './support/tool-runtime.js';
import {
  artifactOf,
  failingCheck,
  hrefOf,
  passingCheck,
  replaceIn,
  tombstonesOf,
  toolNamed,
} from './support/tool-sync.js';

const PYTHON_READY = pythonReady();

beforeAll(() => {
  assertBuiltSdk();
});
afterEach(async () => {
  await closeFastapiApps();
  await removeCopiedApps();
});

const ROUTER = 'web/src/router.ts';
const TASKS_VIEW = 'web/src/views/TasksView.vue';
const STATUS_FILTER = "filters: { status: ['open', 'done'] }";
const REPORTS_VIEW = '<template>\n  <section aria-label="Reports"><h1>Reports</h1></section>\n</template>\n';
const OVERVIEW_VIEW = '<script lang="ts">\n'
  + "import { defineQueryFilters } from 'glirastes/browser';\n\n"
  + "export const overviewFilters = defineQueryFilters({ path: '/overview', filters: { range: ['week', 'month'] } });\n"
  + '</script>\n\n<template>\n  <section aria-label="Overview"><h1>Overview</h1></section>\n</template>\n';

/** Boots a deployment copy of the committed outputs and returns a turn in Alice's session. */
async function deployedTurn(root: string) {
  const app = await bootFastapiApp(await copyApp(root, '.tool-sync-deploy-'));
  expect(app.disabled).toEqual([]);
  return app.turn({ cookie: `session=${app.token}` });
}

describe.skipIf(!PYTHON_READY)('Vue+FastAPI navigation change corpus', () => {
  it('adds a route: the same navigation tool offers it at once, without confirmation', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await writeFile(join(root, 'web/src/views/ReportsView.vue'), REPORTS_VIEW);
    await replaceIn(root, ROUTER, "import OverviewView from './views/OverviewView.vue';\n",
      "import OverviewView from './views/OverviewView.vue';\nimport ReportsView from './views/ReportsView.vue';\n");
    await replaceIn(root, ROUTER, "    { path: '/overview', component: OverviewView },\n",
      "    { path: '/overview', component: OverviewView },\n    { path: '/reports', component: ReportsView },\n");

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

  it('changes a route path: the old destination is refused, the new one works', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.navigate');
    await replaceIn(root, ROUTER, "path: '/overview'", "path: '/insights'");

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    expect(toolNamed(await artifactOf(root), 'ui.navigate').toolId).toBe(before.toolId);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/insights' }))).toBe('/insights');
  }, 240_000);

  it('removes routes: a removed destination is refused, and without routes the tools are tombstoned', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const navigateId = toolNamed(await artifactOf(root), 'ui.navigate').toolId;
    const filterId = toolNamed(await artifactOf(root), 'ui.filter.tasks').toolId;
    await replaceIn(root, ROUTER, "    { path: '/overview', component: OverviewView },\n", '');

    expect((await failingCheck(root)).changes.changed).toEqual([navigateId]);
    await runToolsPipeline({ root, mode: 'write' });
    await passingCheck(root);
    const turn = await deployedTurn(root);
    await expect(turn.execute('ui_navigate', { destination: '/overview' })).rejects.toThrow('Input does not match');
    expect(hrefOf(await turn.execute('ui_navigate', { destination: '/tasks' }))).toBe('/tasks');

    // The redirect of / is not a page, so without the tasks route no page and no filtered page is left.
    await replaceIn(root, ROUTER, "    { path: '/tasks', component: TasksView },\n", '');
    const removed = [navigateId, filterId].sort();
    expect([...(await failingCheck(root)).changes.removed].sort()).toEqual(removed);
    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect([...refreshed.changes.removed].sort()).toEqual(removed);
    expect(await tombstonesOf(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolId: navigateId, stableKey: 'UI navigate' }),
      expect.objectContaining({ toolId: filterId, stableKey: 'UI filter /tasks' }),
    ]));
    await passingCheck(root);
    const after = await deployedTurn(root);
    expect(Object.keys(after.registry)).not.toContain('ui_navigate');
    await expect(after.guard.beforeToolCall({ toolName: 'ui_navigate', input: { destination: '/tasks' } }))
      .rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});

describe.skipIf(!PYTHON_READY)('Vue+FastAPI filter change corpus', () => {
  it('adds a query filter: a new tool, active at once with defaults and no plan confirmation', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    await writeFile(join(root, 'web/src/views/OverviewView.vue'), OVERVIEW_VIEW);

    expect((await failingCheck(root)).changes.added).toHaveLength(1);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
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
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'ui.filter.tasks');
    await replaceIn(root, TASKS_VIEW, STATUS_FILTER, "filters: { status: ['open', 'done', 'blocked'] }");

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
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const filterId = toolNamed(await artifactOf(root), 'ui.filter.tasks').toolId;
    await replaceIn(root, TASKS_VIEW, "import { defineQueryFilters } from 'glirastes/browser';\n\n", '');
    await replaceIn(root, TASKS_VIEW, `defineQueryFilters({ path: '/tasks', ${STATUS_FILTER} })`,
      "{ read: (_search: string): { status?: 'open' | 'done' } => ({}) }");

    expect((await failingCheck(root)).changes.removed).toEqual([filterId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([filterId]);
    expect(await tombstonesOf(root)).toEqual([expect.objectContaining({ toolId: filterId, stableKey: 'UI filter /tasks' })]);
    await passingCheck(root);

    const turn = await deployedTurn(root);
    expect(Object.keys(turn.registry)).not.toContain('ui_filter_tasks');
    await expect(turn.guard.beforeToolCall({ toolName: 'ui_filter_tasks', input: { status: 'open' } }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('ui_filter_tasks', { status: 'open' })).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});
