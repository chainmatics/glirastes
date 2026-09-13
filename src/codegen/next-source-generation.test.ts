import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codegen from './index.js';

const roots: string[] = [];
const digest = (c: string) => `sha256:${c.repeat(43)}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-source-next-'));
  roots.push(root);
  await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
  await writeFile(join(root, 'src/app/api/tasks/route.ts'), '// @ai-ignore\nexport async function GET() { return Response.json([]); }');
  return root;
}
const contract = (candidate: codegen.ScannedRouteCandidate) => ({
  definitionId: `endpoint.${candidate.method.toLowerCase()}.${candidate.path.replaceAll('/', '_')}`,
  inputSchemaDigest: digest('A'), outputSchemaDigest: digest('B'),
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Next source adapter for generation', () => {
  it.each(['tsx', 'jsx'])('discovers and verifies route.%s with JSX syntax', async (extension) => {
    const root = await fixture();
    await rm(join(root, 'src/app/api/tasks/route.ts'));
    await writeFile(join(root, `src/app/api/tasks/route.${extension}`),
      'export function GET() { return new ImageResponse(<div>Hello</div>); }');
    const executions = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    const { state } = codegen.reconcileExecutionInventory({
      appId: '019fb007-0000-7000-8000-000000000001', targetAppKey: 'fixture',
      observed: { complete: true, executions },
    });
    const verified = await codegen.discoverFoundationExecutions({ rootDir: root, inventory: state.inventory });
    expect(verified.executions.map((item) => item.stableKey)).toEqual(['GET /api/tasks']);
  });

  it('excludes Next private folders without consulting their schema contracts', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src/app/api/_private/nested'), { recursive: true });
    await writeFile(join(root, 'src/app/api/_private/nested/route.ts'), 'invalid private helper source');
    const executions = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    expect(executions.map((item) => item.stableKey)).toEqual(['GET /api/tasks']);
  });

  it('preserves scanner-owned identity when a contract resolver mutates its argument', async () => {
    const root = await fixture();
    const expected = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    const executions = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: (candidate) => {
      const resolved = contract(candidate);
      candidate.method = 'DELETE';
      candidate.path = '/api/other';
      candidate.sourceFile = 'other.ts';
      candidate.sourceFingerprint = digest('C');
      return resolved;
    } });
    expect(executions).toEqual(expected);
  });

  it('discovers additions and removals from code without a prebuilt inventory or ignore annotations', async () => {
    const root = await fixture();
    const first = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    expect(first).toHaveLength(1);
    expect(first[0].stableKey).toBe('GET /api/tasks');
    expect((await codegen.scanNextAppRoutes({ rootDir: root })).candidates).toHaveLength(0);
    await mkdir(join(root, 'src/app/api/groups'));
    await writeFile(join(root, 'src/app/api/groups/route.ts'), 'export async function POST() { return Response.json({ ok: true }); }');
    const next = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    expect(next).toHaveLength(2);
    await rm(join(root, 'src/app/api/tasks/route.ts'));
    const final = await codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract });
    expect(final.map((entry) => entry.stableKey)).toEqual(['POST /api/groups']);
    // Existing legacy ignore behavior is intentionally retained.
    expect((await codegen.scanNextAppRoutes({ rootDir: root })).candidates).toHaveLength(1);
  });

  it('rejects unresolved schema contracts instead of fabricating schemas or dropping routes', async () => {
    const root = await fixture();
    await expect(codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: () => undefined }))
      .rejects.toMatchObject({ remediation: 'assess-source-contracts' });
  });

  it('rejects partial syntax discovery before calling any schema resolver', async () => {
    const root = await fixture();
    await writeFile(join(root, 'src/app/api/tasks/route.ts'), 'export { GET } from "./not-resolved";');
    const resolver = vi.fn(contract);
    await expect(codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: resolver }))
      .rejects.toMatchObject({ remediation: 'complete-source-discovery' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a missing source root and linked source rather than inferring an empty inventory', async () => {
    const root = await fixture();
    await expect(codegen.collectNextEndpointExecutions({ rootDir: root, apiDir: 'missing', resolveContract: contract }))
      .rejects.toMatchObject({ remediation: 'complete-source-discovery' });
    await rm(join(root, 'src/app/api/tasks/route.ts'));
    await symlink(join(root, 'package.json'), join(root, 'src/app/api/tasks/route.ts'));
    await expect(codegen.collectNextEndpointExecutions({ rootDir: root, resolveContract: contract }))
      .rejects.toMatchObject({ remediation: 'complete-source-discovery' });
  });

  it('uses the same route paths with an explicit absolute source directory', async () => {
    const root = await fixture();
    const result = await codegen.collectNextEndpointExecutions({
      rootDir: root, apiDir: join(root, 'src/app/api'), resolveContract: contract,
    });
    expect(result[0].stableKey).toBe('GET /api/tasks');
  });

  it('rejects malformed contract output without echoing provider or source contents', async () => {
    const root = await fixture();
    await expect(codegen.collectNextEndpointExecutions({
      rootDir: root, resolveContract: () => ({ definitionId: '', inputSchemaDigest: 'private-source-value', outputSchemaDigest: digest('B') }),
    })).rejects.toMatchObject({ remediation: 'assess-source-contracts' });
  });
});
