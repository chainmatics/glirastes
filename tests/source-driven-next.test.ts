import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(async () => {
  vi.restoreAllMocks();
  await removeCopiedApps();
});

async function refreshedCopy(edit?: (root: string) => Promise<void>): Promise<string> {
  const root = await copyApp(NATIVE_APP);
  if (edit) await edit(root);
  await runToolsPipeline({ root, mode: 'write' });
  return root;
}

async function toolAt(root: string, method: string, path: string) {
  const artifact = AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
  return artifact.tools.find((tool) => tool.method === method && tool.path === path);
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

describe('native endpoints through glirastes tools refresh', () => {
  it('executes the real query with a server-resolved principal and no platform connection', async () => {
    const root = await refreshedCopy();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const app = await bootApp(root);
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(await turn.execute('tasks_list', { status: 'open' })).toMatchObject({
      success: true, tasks: [{ id: '1', title: 'Review release', status: 'open' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('denies a revoked session before executing a pinned tool', async () => {
    const app = await bootApp(await refreshedCopy());
    const token = app.createSession(principal());
    const turn = app.turn({ cookie: `session=${token}` });
    app.revokeSession(token);
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('missing_principal');
  }, 120_000);

  it('keeps the endpoint as role boundary and adds a tool-policy role restriction at runtime', async () => {
    const app = await bootApp(await refreshedCopy());
    const guest = app.turn({ cookie: `session=${app.createSession(principal(['guest']))}` });
    expect(await guest.execute('tasks_list', {})).toMatchObject({ success: false, error: 'Forbidden' });
    const restricted = await bootApp(await refreshedCopy(async (copy) => {
      await writeFile(join(copy, '.glirastes/tool-policy.json'), JSON.stringify({
        schemaVersion: 1, tools: { 'GET /api/tasks': { allowedRoles: ['member'] } }, exclude: [], acceptedRisk: {},
      }));
    }));
    const policed = restricted.turn({ cookie: `session=${restricted.createSession(principal(['guest']))}` });
    await expect(policed.execute('tasks_list', {})).rejects.toThrow('principal_role_denied');
  }, 120_000);

  it('disables the tool as soon as the shared wrapper stops resolving a session', async () => {
    const root = await refreshedCopy((copy) => replaceIn(copy, 'src/query.js',
      '  const principal = resolveSession(request);\n',
      "  const principal = { subjectId: 'anyone', roles: ['member'] };\n"));
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect(await readFile(join(root, '.glirastes/tool-report.json'), 'utf8')).toContain('auth-evidence-missing');
    const app = await bootApp(root);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 120_000);

  it('disables an exported handler without auth evidence instead of trusting it', async () => {
    const root = await refreshedCopy(async (copy) => {
      const route = join(copy, 'src/app/api/tasks/route.js');
      await writeFile(route, (await readFile(route, 'utf8')).replace('export async function GET', 'async function GET')
        + '\nfunction direct() { return Response.json({ tasks: [] }); }\nexport { direct as GET };\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('does not treat a same-spelled wrapper from another module as the declared convention', async () => {
    const root = await refreshedCopy(async (copy) => {
      await cp(join(copy, 'src/app/api/tasks'), join(copy, 'src/app/api/nested/tasks'), { recursive: true });
      await writeFile(join(copy, 'src/app/query.js'), 'export function query() { return Response.json({ tasks: [] }); }\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: true });
    expect(await toolAt(root, 'GET', '/api/nested/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('does not treat a handler parameter shadowing the wrapper as the declared convention', async () => {
    const root = await refreshedCopy((copy) => replaceIn(copy, 'src/app/api/tasks/route.js',
      'GET(request)', 'GET(request, query = () => Response.json({ tasks: [] }))'));
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('keeps an unknown route visible but disabled instead of dropping it', async () => {
    const root = await refreshedCopy(async (copy) => {
      await mkdir(join(copy, 'src/app/api/unknown'), { recursive: true });
      await writeFile(join(copy, 'src/app/api/unknown/route.js'), 'export function GET() { return Response.json({}); }\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: true });
    expect(await toolAt(root, 'GET', '/api/unknown')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);
});
