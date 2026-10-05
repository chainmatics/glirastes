import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createUrlFilterSource, mergeDomains } from './url-filters.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } });
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\n"
  + "import { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href: string) => router.push(href) });\n  return null;\n}\n';
const PAGE = 'export default function Page() { return null; }\n';

const FILES: Record<string, string> = {
  'tsconfig.json': TSCONFIG,
  'src/components/glirastes-bridge.tsx': BRIDGE,
  'src/lib/validations.ts': "export const TASK_STATUSES = ['open', 'done'] as const;\n",
  'src/lib/search-params.ts': "import { parseAsArrayOf, parseAsInteger, parseAsString, parseAsStringLiteral } from 'nuqs';\n"
    + "import { TASK_STATUSES } from '@/lib/validations';\n"
    + 'export const taskSearchParams = {\n  status: parseAsStringLiteral(TASK_STATUSES),\n'
    + '  page: parseAsInteger.withDefault(1),\n  tags: parseAsArrayOf(parseAsString),\n};\n',
  'src/components/task-filters.tsx': "'use client';\nimport { parseAsIsoDate, parseAsString, useQueryState, useQueryStates } from 'nuqs';\n"
    + "import { taskSearchParams } from '@/lib/search-params';\n"
    + 'export function TaskFilters() {\n  const [filters] = useQueryStates(taskSearchParams);\n'
    + "  const [q] = useQueryState('q', parseAsString.withDefault(''));\n"
    + "  const [due] = useQueryState('due', parseAsIsoDate);\n  return <p>{filters.status}{q}{String(due)}</p>;\n}\n",
  'src/app/tasks/page.tsx': "import { TaskFilters } from '@/components/task-filters';\n"
    + 'export default function TasksPage() { return <TaskFilters />; }\n',
  'src/app/reports/page.tsx': 'export default async function ReportsPage({ searchParams }: {\n'
    + "  searchParams: Promise<{ range?: 'week' | 'month'; owner?: string | string[] }>;\n}) {\n"
    + '  const { range } = await searchParams;\n  return <p>{range}</p>;\n}\n',
  'src/app/projects/[projectId]/tasks/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
    + 'export default function ProjectTasks() {\n  const params = useSearchParams();\n'
    + "  return <p>{params.get('sort')}{params.getAll('label').join()}</p>;\n}\n",
  'src/app/login/page.tsx': "'use client';\nimport { useSearchParams } from 'next/navigation';\n"
    + "export default function Login() { return <p>{useSearchParams().get('next')}</p>; }\n",
  'src/app/page.tsx': PAGE,
  'src/views/inbox-filters.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
    + "export const inboxFilters = defineQueryFilters({\n  path: '/inbox',\n"
    + "  filters: { state: ['new', 'read'], page: 'integer', tags: { arrayOf: 'string', format: 'repeat' } },\n});\n",
};

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

const byKey = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.stableKey, observation] as const),
);

describe('url-filters source', () => {
  it('turns nuqs parsers, typed searchParams, useSearchParams and defineQueryFilters into one filter tool per view', async () => {
    const app = await createAppFixture(FILES);
    const observed = await createUrlFilterSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    const tools = byKey(observed.observations);
    expect([...tools.keys()]).toEqual([
      'UI filter /inbox', 'UI filter /projects/:projectId/tasks', 'UI filter /reports', 'UI filter /tasks',
    ]);
    expect(tools.get('UI filter /tasks')).toMatchObject({
      execution: { definitionId: 'ui.filter.tasks', executionKind: 'ui', actionBindingRef: 'glirastes.navigate' },
      contract: {
        source: 'ui-bridge',
        input: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            q: { type: 'string' },
            status: { type: 'string', enum: ['done', 'open'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        uiAction: {
          kind: 'filter', destination: '/tasks',
          keys: [{ key: 'page' }, { key: 'q' }, { key: 'status' }, { key: 'tags', array: 'comma' }],
        },
        params: { path: [], query: ['page', 'q', 'status', 'tags'], body: [] },
      },
      prose: {
        contractDescription: 'Show the /tasks page with URL filters: page (integer), q (text), status (done|open), tags (list of text).',
      },
    });
    expect(tools.get('UI filter /tasks')?.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['filter-parser-unsupported', 'warning'],
      ['filter-domain-open', 'warning'],
    ]);
    expect(tools.get('UI filter /reports')?.contract?.input).toEqual({
      type: 'object',
      properties: { owner: { type: 'string' }, range: { type: 'string', enum: ['month', 'week'] } },
      additionalProperties: false,
    });
    expect(tools.get('UI filter /projects/:projectId/tasks')).toMatchObject({
      execution: { definitionId: 'ui.filter.projectsTasks' },
      contract: {
        input: {
          properties: {
            label: { type: 'array', items: { type: 'string' } },
            sort: { type: 'string' },
            params: {
              type: 'object', properties: { projectId: { type: 'string', minLength: 1 } },
              required: ['projectId'], additionalProperties: false,
            },
          },
          required: ['params'],
        },
        uiAction: { destination: '/projects/:projectId/tasks', keys: [{ key: 'label', array: 'repeat' }, { key: 'sort' }] },
      },
    });
    expect(tools.get('UI filter /inbox')?.contract).toMatchObject({
      input: {
        properties: {
          page: { type: 'integer' },
          state: { type: 'string', enum: ['new', 'read'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      uiAction: { keys: [{ key: 'page' }, { key: 'state' }, { key: 'tags', array: 'repeat' }] },
    });
    expect(tools.get('UI filter /inbox')?.findings.some((finding) => finding.code === 'filter-domain-open')).toBe(true);
    expect(observed.observations.every((tool) => !tool.findings.some((finding) => finding.severity === 'needs_attention'))).toBe(true);
  }, 120_000);

  it('needs attention on every filter tool when no navigation bridge is mounted', async () => {
    const { 'src/components/glirastes-bridge.tsx': _bridge, ...files } = FILES;
    const app = await createAppFixture(files);
    const observed = await createUrlFilterSource().observe(context(app.root));
    for (const tool of observed.observations) {
      expect(tool.findings).toContainEqual(expect.objectContaining({
        code: 'navigation-bridge-missing', severity: 'needs_attention', subjectRef: tool.execution.stableKey,
      }));
    }
  }, 120_000);

  it('leaves out views of excluded pages and paths and reports unreadable definitions', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/glirastes-bridge.tsx': BRIDGE,
      'src/admin.ts': "import { defineQueryFilters } from 'glirastes/browser';\n"
        + "export const admin = defineQueryFilters({ path: '/login', filters: { tab: ['a', 'b'] } });\n"
        + "export const users = defineQueryFilters({ path: '/admin/users', filters: { role: ['owner'] } });\n"
        + "declare const path: string;\nexport const dynamic = defineQueryFilters({ path, filters: {} });\n",
      'src/app/login/page.tsx': PAGE,
    });
    // `/admin/users` has no page file (an SPA view); the policy exclusion still applies to it.
    const observed = await createUrlFilterSource().observe(context(app.root, [{ match: 'PAGE /admin/**', reason: 'internal' }]));
    expect(observed.observations).toEqual([]);
    expect(observed.excluded).toEqual([
      { stableKey: 'UI filter /admin/users', reason: 'internal', origin: 'policy' },
      { stableKey: 'UI filter /login', reason: 'auth-page', origin: 'default' },
    ]);
    expect(observed.findings).toEqual([expect.objectContaining({
      code: 'filter-definition-unreadable', severity: 'warning', subjectRef: 'src/admin.ts',
    })]);
  }, 120_000);
});

const keysOf = (tool: ObservedTool | undefined): string[] => (
  tool?.contract?.uiAction?.kind === 'filter' ? tool.contract.uiAction.keys.map((entry) => entry.key) : []
);

describe('url-filters source: what a view is credited with', () => {
  const FILES_BY_BINDING: Record<string, string> = {
    'tsconfig.json': TSCONFIG,
    'src/components/glirastes-bridge.tsx': BRIDGE,
    'src/components/button.tsx': 'export function Button() { return null; }\n',
    'src/components/filters.tsx': "'use client';\nimport { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';\n"
      + "export function StatusFilter() {\n  const [status] = useQueryState('status', parseAsStringLiteral(['open', 'done']));\n  return <p>{status}</p>;\n}\n"
      + "export function OwnerFilter() {\n  const [owner] = useQueryState('owner', parseAsString);\n  return <p>{owner}</p>;\n}\n",
    'src/components/index.ts': "export * from './filters';\nexport { Button } from './button';\n",
    'src/app/settings/page.tsx': "import { Button } from '@/components';\n"
      + 'export default function Settings() { return <Button />; }\n',
    'src/app/tasks/page.tsx': "import { StatusFilter } from '@/components';\n"
      + 'export default function Tasks() { return <StatusFilter />; }\n',
    'src/app/people/page.tsx': "import * as Filters from '@/components/filters';\n"
      + 'export default function People() { return <Filters.OwnerFilter />; }\n',
  };

  it('credits a page only with the filters of the bindings it uses, never with a barrel or a module it merely re-exports', async () => {
    const app = await createAppFixture(FILES_BY_BINDING);
    const observed = await createUrlFilterSource().observe(context(app.root));
    const tools = byKey(observed.observations);
    // `/settings` imports only `Button` from a barrel that also re-exports the filter components.
    expect([...tools.keys()]).toEqual(['UI filter /people', 'UI filter /tasks']);
    expect(observed.findings).toEqual([]);
    expect(keysOf(tools.get('UI filter /tasks'))).toEqual(['status']);
    expect(keysOf(tools.get('UI filter /people'))).toEqual(['owner']);
  }, 120_000);

  it('credits a search params cache only to the page that references its binding', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/glirastes-bridge.tsx': BRIDGE,
      'src/lib/search-params.ts': "import { createSearchParamsCache, parseAsInteger, parseAsStringLiteral } from 'nuqs/server';\n"
        + "export const tasksCache = createSearchParamsCache({ status: parseAsStringLiteral(['open', 'done']) });\n"
        + 'export const reportsCache = createSearchParamsCache({ year: parseAsInteger }, { urlKeys: { year: \'y\' } });\n'
        + 'export const caches = {\n'
        + "  people: createSearchParamsCache({ team: parseAsStringLiteral(['a', 'b']) }),\n"
        + "  orders: createSearchParamsCache({ sort: parseAsStringLiteral(['asc', 'desc']) }),\n};\n",
      'src/app/tasks/page.tsx': "import { tasksCache } from '@/lib/search-params';\n"
        + 'export default function Tasks() { tasksCache.parse({}); return null; }\n',
      'src/app/reports/page.tsx': "import { reportsCache } from '@/lib/search-params';\n"
        + 'export default function Reports() { reportsCache.parse({}); return null; }\n',
      'src/app/people/page.tsx': "import { caches } from '@/lib/search-params';\n"
        + 'export default function People() { caches.people.parse({}); return null; }\n',
      'src/app/orders/page.tsx': "import { caches } from '@/lib/search-params';\n"
        + 'export default function Orders() { return <p>{String(caches.orders.parse({}))}</p>; }\n',
    });
    const observed = await createUrlFilterSource().observe(context(app.root));
    const tools = byKey(observed.observations);
    expect(keysOf(tools.get('UI filter /tasks'))).toEqual(['status']);
    expect(keysOf(tools.get('UI filter /reports'))).toEqual(['y']);
    expect(keysOf(tools.get('UI filter /people'))).toEqual(['team']);
    expect(keysOf(tools.get('UI filter /orders'))).toEqual(['sort']);
    expect(tools.get('UI filter /reports')?.contract?.input).toMatchObject({ properties: { y: { type: 'integer' } } });
  }, 120_000);

  it('follows hooks, default exports, helpers of the same file and reference cycles, and leaves unrelated exports of a module out', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/components/glirastes-bridge.tsx': BRIDGE,
      'src/lib/use-filters.ts': "import { parseAsString, useQueryState } from 'nuqs';\n"
        + "export function useOwnerFilter() { return useQueryState('owner', parseAsString); }\n"
        + "export function useUnrelated() { return useQueryState('unrelated', parseAsString); }\n",
      'src/components/toolbar.tsx': "import { useOwnerFilter } from '@/lib/use-filters';\n"
        + 'function Inner() {\n  const [owner] = useOwnerFilter();\n  return <p>{owner ?? <Toolbar />}</p>;\n}\n'
        + 'export default function Toolbar() { return <Inner />; }\n',
      'src/components/wrapped.tsx': "import Toolbar from './toolbar';\nconst Wrapped = () => <Toolbar />;\nexport default Wrapped;\n",
      'src/app/board/page.tsx': "import Wrapped from '@/components/wrapped';\n"
        + 'export default function Board() { return <Wrapped />; }\n',
    });
    const observed = await createUrlFilterSource().observe(context(app.root));
    const tools = byKey(observed.observations);
    expect([...tools.keys()]).toEqual(['UI filter /board']);
    expect(keysOf(tools.get('UI filter /board'))).toEqual(['owner']);
  }, 120_000);

  it('does not credit a filter that a page imports but never uses', async () => {
    const app = await createAppFixture({
      ...FILES_BY_BINDING,
      'src/app/settings/page.tsx': "import { Button, StatusFilter } from '@/components';\n"
        + 'export default function Settings() { return <Button />; }\n',
    });
    const observed = await createUrlFilterSource().observe(context(app.root));
    expect(byKey(observed.observations).has('UI filter /settings')).toBe(false);
    expect(observed.findings).toEqual([]);
  }, 120_000);
});

describe('mergeDomains', () => {
  it.each([
    [{ kind: 'string' }, { kind: 'enum', values: ['a'] }, { kind: 'enum', values: ['a'] }],
    [{ kind: 'enum', values: ['b'] }, { kind: 'enum', values: ['a', 'b'] }, { kind: 'enum', values: ['a', 'b'] }],
    [{ kind: 'integer' }, { kind: 'integer' }, { kind: 'integer' }],
    [{ kind: 'integer' }, { kind: 'boolean' }, undefined],
  ] as const)('merges %j and %j', (left, right, expected) => {
    expect(mergeDomains(left as never, right as never)).toEqual(expected);
  });
});
