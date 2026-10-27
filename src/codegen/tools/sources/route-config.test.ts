import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createReactRouterSource, enumerateRouteConfigPages } from './route-config.js';
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
  ])('stops instead of guessing for %s', async (_label, source, reason) => {
    const app = await createAppFixture({ ...FILES, 'src/routes.tsx': source }, { toolsConfig: { sources: ['react-router'] } });
    const observed = await createReactRouterSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011' })]);
    expect(observed.findings[0]!.message).toContain(reason);
  });
});
