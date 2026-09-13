import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateReference, tenantId } from '../examples/source-driven-next/adapter.mjs';

const examples = fileURLToPath(new URL('../examples/source-driven-next/', import.meta.url));
const roots: string[] = [];
async function fixture(copyFrom = join(examples, 'native')) {
  const root = await mkdtemp(join(examples, '.proof-'));
  roots.push(root);
  await cp(copyFrom, root, { recursive: true });
  const auth = await import(pathToFileURL(join(root, 'src/auth.js')).href);
  const principal = { subjectId: 'alice', tenantId, roles: ['member'], attributes: {} };
  const token = auth.createSession(principal);
  const request = new Request('http://fixture.local/chat', { headers: { cookie: `session=${token}` } });
  return { root, auth, token, request };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('native source contracts through the local runtime', () => {
  it('executes the real query with a server-resolved principal and no platform connection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const { root, auth, request } = await fixture();
    const generated = await generateReference({ rootDir: root });
    const turn = generated.createTurn({ request, resolvePrincipal: () => auth.resolveSession(request) });
    expect(generated.state.inventory.executions).toHaveLength(1);
    expect(await turn.execute('GET /api/tasks', { status: 'open' })).toMatchObject({
      success: true, tasks: [{ id: '1', title: 'Review release', status: 'open' }],
    });
    expect(turn.snapshot.manifestRevision.signature.keyId).toBeTruthy();
    expect(turn.snapshot.manifestRevision.tools[0].inputSchemaDigest)
      .toBe(generated.bindings[0].inputSchemaDigest);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds, changes and deletes endpoints from source without editing the adapter', async () => {
    const { root, auth, request } = await fixture();
    const first = await generateReference({ rootDir: root });
    const addedDir = join(root, 'src/app/api/completed');
    await cp(join(root, 'src/app/api/tasks'), addedDir, { recursive: true });
    const added = await generateReference({ rootDir: root, previous: first.state });
    expect(added.changes.added).toHaveLength(1);
    expect(await added.createTurn({ request, resolvePrincipal: () => auth.resolveSession(request) })
      .execute('GET /api/completed', { status: 'done' })).toMatchObject({ tasks: [{ id: '2' }] });

    const contractPath = join(addedDir, 'contract.js');
    await writeFile(contractPath, (await readFile(contractPath, 'utf8')).replace("['open', 'done']", "['done']"));
    const routePath = join(addedDir, 'route.js');
    await writeFile(routePath, (await readFile(routePath, 'utf8')).replace('Write tests', 'Write verified tests'));
    // A new source build starts a fresh native module graph (standalone restart).
    const redeployed = await fixture(root);
    const changed = await generateReference({ rootDir: redeployed.root, previous: added.state });
    expect(changed.changes.changed).toHaveLength(1);
    const turn = changed.createTurn({ request: redeployed.request, resolvePrincipal: () => redeployed.auth.resolveSession(redeployed.request) });
    await expect(turn.execute('GET /api/completed', { status: 'open' })).rejects.toThrow('Input');
    expect(await turn.execute('GET /api/completed', { status: 'done' }))
      .toMatchObject({ tasks: [{ id: '2', title: 'Write verified tests' }] });

    await rm(join(redeployed.root, 'src/app/api/completed/route.js'));
    const removed = await generateReference({ rootDir: redeployed.root, previous: changed.state });
    expect(removed.changes.removed).toHaveLength(1);
    expect(removed.state.tombstones).toHaveLength(1);
    await expect(removed.createTurn({ request, resolvePrincipal: () => auth.resolveSession(request) })
      .execute('GET /api/completed', {})).rejects.toThrow('unavailable');
  });

  it('denies a revoked session before executing a previously pinned tool', async () => {
    const { root, auth, request, token } = await fixture();
    const generated = await generateReference({ rootDir: root });
    const turn = generated.createTurn({ request, resolvePrincipal: () => auth.resolveSession(request) });
    auth.revokeSession(token);
    await expect(turn.execute('GET /api/tasks', {})).rejects.toThrow('missing_principal');
  });

  it('retains the native role boundary and rejects missing sessions at turn start', async () => {
    const { root, auth } = await fixture();
    const generated = await generateReference({ rootDir: root });
    const token = auth.createSession({ subjectId: 'alice', tenantId, roles: ['guest'], attributes: {} });
    const request = new Request('http://fixture.local/chat', { headers: { cookie: `session=${token}` } });
    const turn = generated.createTurn({ request, resolvePrincipal: () => auth.resolveSession(request) });
    await expect(turn.execute('GET /api/tasks', {})).rejects.toThrow('principal_role_denied');
    expect(() => generated.createTurn({ request, resolvePrincipal: () => undefined })).toThrow('missing_principal');
  });

  it('requires renewed assessment if the native authorization wrapper changes', async () => {
    const { root } = await fixture();
    const wrapper = join(root, 'src/query.js');
    await writeFile(wrapper, (await readFile(wrapper, 'utf8')).replace("roles.includes('member')", "roles.includes('guest')"));
    await expect(generateReference({ rootDir: root })).rejects.toThrow('assessment required');
  });

  it('rejects an exported handler that differs from the reviewed local GET function', async () => {
    const { root } = await fixture();
    const route = join(root, 'src/app/api/tasks/route.js');
    await writeFile(route, (await readFile(route, 'utf8')).replace('export async function GET', 'async function GET')
      + '\nfunction direct() { return Response.json({}); }\nexport { direct as GET };');
    await expect(generateReference({ rootDir: root })).rejects.toThrow('contract');
  });

  it('rejects a same-spelled wrapper import resolving to a different module', async () => {
    const { root } = await fixture();
    await cp(join(root, 'src/app/api/tasks'), join(root, 'src/app/api/nested/tasks'), { recursive: true });
    await writeFile(join(root, 'src/app/query.js'), 'export function query() { return Response.json({ tasks: [] }); }');
    await expect(generateReference({ rootDir: root })).rejects.toThrow('contract');
  });

  it('rejects handler parameters that shadow the verified query wrapper', async () => {
    const { root } = await fixture();
    const route = join(root, 'src/app/api/tasks/route.js');
    await writeFile(route, (await readFile(route, 'utf8')).replace('GET(request)',
      'GET(request, query = () => Response.json({ tasks: [] }))'));
    const outcome = await generateReference({ rootDir: root }).then(() => 'accepted', () => 'rejected');
    expect(outcome).toBe('rejected');
  });

  it('rejects routes without native contracts instead of retaining an old catalogue', async () => {
    const { root } = await fixture();
    const before = await generateReference({ rootDir: root });
    const sourceFile = join(root, 'src/app/api/unknown/route.js');
    await mkdir(dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, 'export function GET() { return Response.json({}); }');
    await expect(generateReference({ rootDir: root, previous: before.state })).rejects.toThrow('contract');
    expect(before.state.inventory.executions).toHaveLength(1);
  });
});
