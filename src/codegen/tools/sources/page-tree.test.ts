import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { enumeratePages } from './page-tree.js';

const outsideDirs: string[] = [];
afterEach(async () => {
  await removeAppFixtures();
  for (const directory of outsideDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const PAGE = 'export default function Page() { return null; }\n';

describe('enumeratePages', () => {
  it('maps the app tree to destinations and gives every left-out page a reason', async () => {
    const app = await createAppFixture({
      'src/app/page.tsx': PAGE,
      'src/app/(dashboard)/tasks/page.tsx': PAGE,
      'src/app/(dashboard)/tasks/[taskId]/page.tsx': PAGE,
      'src/app/[locale]/overview/page.jsx': PAGE,
      'src/app/@modal/settings/page.tsx': PAGE,
      'src/app/@modal/(.)tasks/[taskId]/page.tsx': PAGE,
      'src/app/_components/page.tsx': PAGE,
      'src/app/api/tasks/page.tsx': PAGE,
      'src/app/docs/[...slug]/page.mdx': PAGE,
      'src/app/login/page.tsx': PAGE,
      'src/app/auth/callback/page.tsx': PAGE,
      'src/app/mcp/page.tsx': PAGE,
      'src/app/admin/users/page.tsx': PAGE,
      'src/app/tasks/layout.tsx': 'export default function Layout() { return null; }\n',
    });
    const tree = await enumeratePages(app.root, { stripSegments: ['[locale]'] }, [
      { match: '* /admin/**', reason: 'internal' },
    ]);
    expect(tree).toEqual({
      complete: true,
      pages: [
        { path: '/', params: [], file: 'src/app/page.tsx' },
        { path: '/overview', params: [], file: 'src/app/[locale]/overview/page.jsx' },
        { path: '/settings', params: [], file: 'src/app/@modal/settings/page.tsx' },
        { path: '/tasks', params: [], file: 'src/app/(dashboard)/tasks/page.tsx' },
        { path: '/tasks/:taskId', params: ['taskId'], file: 'src/app/(dashboard)/tasks/[taskId]/page.tsx' },
      ],
      excluded: [
        { stableKey: 'PAGE /admin/users', reason: 'internal', origin: 'policy' },
        { stableKey: 'PAGE /auth/callback', reason: 'auth-page', origin: 'default' },
        { stableKey: 'PAGE /docs/*slug', reason: 'catch-all-page', origin: 'default' },
        { stableKey: 'PAGE /login', reason: 'auth-page', origin: 'default' },
        { stableKey: 'PAGE /mcp', reason: 'mcp-page', origin: 'default' },
        { stableKey: 'PAGE /tasks/:taskId', reason: 'intercepting-page', origin: 'default' },
      ],
      findings: [],
    });
  });

  it('excludes pages by PAGE or any-method patterns, never by endpoint methods', async () => {
    const app = await createAppFixture({
      'src/app/admin/page.tsx': PAGE,
      'src/app/reports/page.tsx': PAGE,
      'src/app/tasks/page.tsx': PAGE,
    });
    const tree = await enumeratePages(app.root, {}, [
      { match: 'PAGE /admin', reason: 'internal' },
      { match: 'GET /reports', reason: 'endpoint only' },
    ]);
    expect(tree).toMatchObject({
      pages: [{ path: '/reports' }, { path: '/tasks' }],
      excluded: [{ stableKey: 'PAGE /admin', reason: 'internal', origin: 'policy' }],
    });
  });

  it('prefers app/ when there is no src/app and reports nothing without an app dir', async () => {
    const app = await createAppFixture({ 'app/reports/page.js': PAGE });
    expect(await enumeratePages(app.root, {}, [])).toMatchObject({
      complete: true,
      pages: [{ path: '/reports', params: [], file: 'app/reports/page.js' }],
    });
    const empty = await createAppFixture({});
    expect(await enumeratePages(empty.root, {}, [])).toEqual({ complete: true, pages: [], excluded: [], findings: [] });
  });

  it('keeps the first of two pages for one path and says so', async () => {
    const app = await createAppFixture({
      'src/app/(a)/tasks/page.tsx': PAGE,
      'src/app/(b)/tasks/page.tsx': PAGE,
    });
    const tree = await enumeratePages(app.root, {}, []);
    expect(tree).toMatchObject({
      pages: [{ path: '/tasks', file: 'src/app/(a)/tasks/page.tsx' }],
      findings: [expect.objectContaining({ code: 'page-path-duplicated', subjectRef: 'PAGE /tasks', severity: 'warning' })],
    });
  });

  it('refuses a linked folder instead of skipping its pages', async () => {
    const app = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE });
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    outsideDirs.push(outside);
    await symlink(outside, app.path('src/app/linked'), 'dir');
    expect(await enumeratePages(app.root, {}, [])).toEqual({
      complete: false,
      reason: 'src/app/linked is a link; pages behind it cannot be enumerated.',
    });
  });

  it('ignores a link that is no folder and no page file', async () => {
    const app = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE, 'src/app/README.md': 'x' });
    await symlink(app.path('src/app/README.md'), app.path('src/app/tasks/NOTES.md'), 'file');
    expect(await enumeratePages(app.root, {}, [])).toMatchObject({
      complete: true,
      pages: [{ path: '/tasks', file: 'src/app/tasks/page.tsx' }],
    });
  });

  it('refuses a linked page file instead of skipping its page', async () => {
    const app = await createAppFixture({ 'src/app/tasks/page.tsx': PAGE });
    await symlink(app.path('src/app/tasks/page.tsx'), app.path('src/app/page.tsx'), 'file');
    expect(await enumeratePages(app.root, {}, [])).toEqual({
      complete: false,
      reason: 'src/app/page.tsx is a link; pages behind it cannot be enumerated.',
    });
  });
});
