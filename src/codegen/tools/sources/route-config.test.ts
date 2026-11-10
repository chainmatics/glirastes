import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { nextActionFor } from '../findings.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createReactRouterSource, createVueRouterSource, enumerateRouteConfigPages } from './route-config.js';
import { createUrlFilterSource } from './url-filters.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', types: [] } });
const BRIDGE = "import { useNavigate } from 'react-router';\nimport { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const navigate = useNavigate();\n'
  + '  useGlirastesNavigationBridge({ push: (href: string) => navigate(href) });\n  return null;\n}\n';
const ROUTES = "import { createBrowserRouter } from 'react-router';\n"
  + "import { Layout } from './Layout';\nimport { TasksPage } from './pages/TasksPage';\nimport TaskDetail from './pages/TaskDetail';\n"
  + 'export const routes = [\n'
  + "  { path: '/', Component: Layout, children: [\n"
  + '    { index: true, element: <TasksPage /> },\n'
  + "    { path: 'tasks/:taskId', Component: TaskDetail },\n"
  + "    { path: 'reports', lazy: () => import('./pages/Reports') },\n"
  + "    { path: 'login', Component: TasksPage },\n"
  + "    { path: '*', Component: TasksPage },\n"
  + '  ] },\n];\nexport const router = createBrowserRouter(routes);\n';
const FILES: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'src/bridge.tsx': BRIDGE,
  'src/routes.tsx': ROUTES,
  'src/Layout.tsx': 'export function Layout() { return null; }\n',
  'src/pages/TasksPage.tsx': "import { parseAsStringLiteral, useQueryState } from 'nuqs';\n"
    + "export function TasksPage() {\n  const [status] = useQueryState('status', parseAsStringLiteral(['open', 'done'] as const));\n"
    + '  return <p>{status}</p>;\n}\nexport function Unrelated() {\n'
    + "  const [q] = useQueryState('q');\n  return <p>{q}</p>;\n}\n",
  'src/pages/TaskDetail.tsx': 'export default function TaskDetail() { return null; }\n',
  'src/pages/Reports.tsx': "import { parseAsInteger, useQueryState } from 'nuqs';\n"
    + "export function Component() {\n  const [year] = useQueryState('year', parseAsInteger);\n  return <p>{year}</p>;\n}\n",
};

function context(root: string): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

describe('react-router route objects', () => {
  it('lists every route as a page or a reasoned exclusion', async () => {
    const app = await createAppFixture(FILES);
    const tree = await enumerateRouteConfigPages(app.root, {}, []);

    expect(tree).toEqual({
      complete: true,
      pages: [
        { path: '/', params: [], file: 'src/pages/TasksPage.tsx', component: 'TasksPage' },
        { path: '/reports', params: [], file: 'src/pages/Reports.tsx', component: 'Component' },
        { path: '/tasks/:taskId', params: ['taskId'], file: 'src/pages/TaskDetail.tsx', component: 'default' },
      ],
      excluded: [
        { stableKey: 'PAGE /*', reason: 'catch-all-page', origin: 'default' },
        { stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' },
      ],
      findings: [],
    });
  });

  it('offers the routes as ui.navigate destinations through the navigation bridge', async () => {
    const app = await createAppFixture(FILES, { toolsConfig: { sources: ['react-router'] } });
    const observed = await createReactRouterSource().observe(context(app.root));

    expect(observed.complete).toBe(true);
    expect(observed.observations.map((tool) => tool.execution.definitionId)).toEqual(['ui.navigate']);
    expect(observed.observations[0]!.contract!.input).toMatchObject({
      properties: { destination: { enum: ['/', '/reports', '/tasks/:taskId'] } },
    });
    expect(observed.observations[0]!.findings).toEqual([]);
  });

  it('credits a filter to the component the route renders, not its whole module', async () => {
    const app = await createAppFixture(FILES, { toolsConfig: { sources: ['react-router', 'url-filters'] } });
    const observed = await createUrlFilterSource({ pages: 'react-router' }).observe(context(app.root));

    expect(Object.fromEntries(observed.observations.map((tool) => [
      tool.execution.definitionId, Object.keys((tool.contract!.input as { properties: object }).properties),
    ]))).toEqual({ 'ui.filter.home': ['status'], 'ui.filter.reports': ['year'] });
  });

  it.each([
    ['JSX routes', "import { Route } from 'react-router';\nexport const tree = <Route path=\"/\" />;\n", 'declares JSX routes'],
    ['a spread route', "import { createBrowserRouter } from 'react-router';\nconst base = { path: '/' };\n"
      + 'export const router = createBrowserRouter([{ ...base }]);\n', 'spreads a route object'],
    ['a computed path', "import { createBrowserRouter } from 'react-router';\nconst p = '/x';\n"
      + 'export const router = createBrowserRouter([{ path: p }]);\n', 'not a string literal'],
    ['a wrapped element', "import { createBrowserRouter } from 'react-router';\nimport { Suspense } from 'react';\n"
      + "import { TasksPage } from './pages/TasksPage';\n"
      + "export const router = createBrowserRouter([{ path: '/x', element: <Suspense><TasksPage /></Suspense> }]);\n",
      'component cannot be resolved'],
    ['an inline component', "import { createBrowserRouter } from 'react-router';\n"
      + "export const router = createBrowserRouter([{ path: '/x', Component: () => <div /> }]);\n",
      'component cannot be resolved'],
  ])('stops instead of guessing for %s', async (_label, source, reason) => {
    const app = await createAppFixture({ ...FILES, 'src/routes.tsx': source }, { toolsConfig: { sources: ['react-router'] } });
    const observed = await createReactRouterSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011' })]);
    expect(observed.findings[0]!.message).toContain(reason);
  });
});

const VUE_ROUTER = "import { createRouter, createWebHistory } from 'vue-router';\n"
  + "import TasksView from '../views/TasksView.vue';\n"
  + 'const routes = [\n'
  + "  { path: '/', component: () => import('../views/HomeView.vue') },\n"
  + "  { path: '/tasks', component: TasksView, children: [\n"
  + "    { path: '', component: TasksView },\n"
  + "    { path: ':taskId', component: () => import('../views/TaskDetail.vue') },\n"
  + '  ] },\n'
  + "  { path: '/reports', components: { default: () => import('../views/ReportsView.vue') } },\n"
  + "  { path: '/old', redirect: '/tasks' },\n"
  + "  { path: '/login', component: TasksView },\n"
  + "  { path: '/:pathMatch(.*)*', component: () => import('../views/NotFound.vue') },\n"
  + '];\nexport const router = createRouter({ history: createWebHistory(), routes });\n';
const VUE_VIEW = '<template><p>View</p></template>\n';
const VUE_FILES: Record<string, string> = {
  'src/main.ts': "import { registerNavigationBridge } from 'glirastes/browser';\nimport { router } from './router';\n"
    + 'registerNavigationBridge({ push: (href: string) => { void router.push(href); } });\n',
  'src/router/index.ts': VUE_ROUTER,
  'src/views/TasksView.vue': '<script setup lang="ts">\nconst title = \'Tasks\';\n</script>\n<template><h1>{{ title }}</h1></template>\n',
  'src/views/HomeView.vue': VUE_VIEW,
  'src/views/TaskDetail.vue': VUE_VIEW,
  'src/views/ReportsView.vue': '<script lang="ts">\n'
    + "import { defineQueryFilters } from 'glirastes/browser';\n"
    + "export const reportFilters = defineQueryFilters({ path: '/reports', filters: { range: ['week', 'month'] } });\n"
    + '</script>\n<template><p>Reports</p></template>\n',
  'src/views/NotFound.vue': VUE_VIEW,
};

describe('vue-router routes', () => {
  it('lists every route of createRouter as a page of its single-file component, or a reasoned exclusion', async () => {
    const app = await createAppFixture(VUE_FILES);
    const tree = await enumerateRouteConfigPages(app.root, {}, [], 'vue-router');

    expect(tree).toEqual({
      complete: true,
      pages: [
        { path: '/', params: [], file: 'src/views/HomeView.vue', component: 'default' },
        { path: '/reports', params: [], file: 'src/views/ReportsView.vue', component: 'default' },
        { path: '/tasks', params: [], file: 'src/views/TasksView.vue', component: 'default' },
        { path: '/tasks/:taskId', params: ['taskId'], file: 'src/views/TaskDetail.vue', component: 'default' },
      ],
      excluded: [
        { stableKey: 'PAGE /:pathMatch(.*)*', reason: 'catch-all-page', origin: 'default' },
        { stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' },
      ],
      findings: [],
    });
  });

  it('offers the routes through registerNavigationBridge and reads filters of a .vue view', async () => {
    const app = await createAppFixture(VUE_FILES, { toolsConfig: { sources: ['vue-router', 'url-filters'] } });
    const navigation = await createVueRouterSource().observe(context(app.root));
    const filters = await createUrlFilterSource({ pages: 'vue-router' }).observe(context(app.root));

    expect(navigation.complete).toBe(true);
    expect(navigation.observations[0]!.contract!.input).toMatchObject({
      properties: { destination: { enum: ['/', '/reports', '/tasks', '/tasks/:taskId'] } },
    });
    expect(navigation.observations[0]!.findings).toEqual([]);
    expect(filters.observations.map((tool) => tool.execution.definitionId)).toEqual(['ui.filter.reports']);
  });

  it('leaves out a query filter for a path the routes do not serve, with a warning', async () => {
    const app = await createAppFixture({
      ...VUE_FILES,
      'src/views/archive-filters.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
        + "export const archive = defineQueryFilters({ path: '/archive', filters: { year: ['2025', '2026'] } });\n"
        + "export const detail = defineQueryFilters({ path: '/tasks/:id', filters: { tab: ['notes', 'files'] } });\n",
    }, { toolsConfig: { sources: ['vue-router', 'url-filters'] } });
    const observed = await createUrlFilterSource({ pages: 'vue-router' }).observe(context(app.root));

    // `/tasks/:id` is the route `/tasks/:taskId`; a parameter name does not change the page.
    expect(observed.observations.map((tool) => tool.execution.definitionId).sort())
      .toEqual(['ui.filter.reports', 'ui.filter.tasksItem']);
    expect(observed.findings).toEqual([{
      code: 'filter-path-unrouted', severity: 'warning', subjectRef: 'UI filter /archive',
      message: 'src/views/archive-filters.ts defines query filters for /archive, which no route serves; no filter tool is generated for it.',
      nextAction: nextActionFor('filter-path-unrouted'),
    }]);
  });

  it('stops instead of guessing for a route alias', async () => {
    const app = await createAppFixture({
      ...VUE_FILES,
      'src/router/index.ts': VUE_ROUTER.replace("{ path: '/login', component: TasksView }", "{ path: '/login', alias: '/signin', component: TasksView }"),
    }, { toolsConfig: { sources: ['vue-router'] } });
    const observed = await createVueRouterSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message).toContain('has a route alias');
  });

  it('stops for a view it cannot resolve and excludes custom-regex and repeatable params', async () => {
    const inline = await createAppFixture({
      ...VUE_FILES,
      'src/router/index.ts': VUE_ROUTER.replace("{ path: '/login', component: TasksView }", "{ path: '/inline', component: { template: '<p />' } }"),
    }, { toolsConfig: { sources: ['vue-router'] } });
    expect((await createVueRouterSource().observe(context(inline.root))).findings[0]!.message)
      .toContain('"/inline" whose component cannot be resolved');

    const shaped = await createAppFixture({
      ...VUE_FILES,
      'src/router/index.ts': VUE_ROUTER.replace("{ path: '/old', redirect: '/tasks' }",
        "{ path: '/old', redirect: '/tasks', component: TasksView }, { path: '/n/:id([0-9]+)', component: TasksView },"
        + " { path: '/c/:chapters+', component: TasksView }"),
    });
    const tree = await enumerateRouteConfigPages(shaped.root, {}, [], 'vue-router');
    expect(tree.complete && tree.pages.map((page) => page.path)).toEqual(['/', '/reports', '/tasks', '/tasks/:taskId']);
    expect(tree.complete && tree.excluded.map(({ stableKey, reason }) => [stableKey, reason])).toEqual([
      ['PAGE /:pathMatch(.*)*', 'catch-all-page'],
      ['PAGE /c/:chapters+', 'unsupported-path'],
      ['PAGE /login', 'auth-page'],
      ['PAGE /n/:id([0-9]+)', 'unsupported-path'],
    ]);
  });
});
