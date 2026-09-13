import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as codegen from './index.js';

const appId = '019fb007-0000-7000-8000-000000000001';
const otherAppId = '019fb007-0000-7000-8000-000000000002';
const digest = (char: string) => `sha256:${char.repeat(43)}`;
const roots: string[] = [];
async function observedRoute(root: string, path: string) {
  const sourceFile = `src/app/api/${path}/route.ts`;
  const source = await readFile(join(root, sourceFile), 'utf8');
  return {
    definitionId: `${path}.list`, stableKey: `GET /api/${path}`, executionKind: 'endpoint' as const,
    method: 'GET' as const, path: `/api/${path}`, sourceFile,
    sourceFingerprint: codegen.createRouteSourceFingerprint(source, 'GET', `/api/${path}`),
    inputSchemaDigest: digest('A'), outputSchemaDigest: digest('B'),
  };
}
const ui = (name: string) => ({
  definitionId: `ui.${name}`, stableKey: `UI ${name}`, executionKind: 'ui' as const,
  actionBindingRef: `ui.${name}`, actionId: name,
  sourceFingerprint: `sha256:${createHash('sha256').update(name).digest('base64url')}`, inputSchemaDigest: digest('D'), outputSchemaDigest: digest('E'),
});
const generate = (executions: unknown[], previous?: unknown, complete = true, selectedAppId = appId) =>
  codegen.reconcileExecutionInventory({
    appId: selectedAppId, targetAppKey: 'fixture', previous,
    observed: { complete, executions },
  });

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('source-driven execution inventory generation', () => {
  it('rejects conflicting fingerprints in observations and previous state', () => {
    const first = ui('filter');
    const second = { ...ui('navigate'), sourceFingerprint: first.sourceFingerprint };
    expect(() => generate([first, second])).toThrow('fingerprint');
    const previous = generate([first, ui('navigate')]).state;
    previous.inventory.executions[1].sourceFingerprint = previous.inventory.executions[0].sourceFingerprint;
    expect(() => generate([], previous)).toThrow('fingerprint');
  });

  it('rejects endpoint identity inconsistent with its method and path', () => {
    expect(() => generate([{
      definitionId: 'tasks.list', executionKind: 'endpoint', stableKey: 'DELETE /api/tasks',
      method: 'GET', path: '/api/tasks', sourceFile: 'src/app/api/tasks/route.ts',
      sourceFingerprint: digest('C'), inputSchemaDigest: digest('D'), outputSchemaDigest: digest('E'),
    }])).toThrow('stable key');
  });
  it('reconciles additions, changes and removals from source observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glirastes-generation-'));
    roots.push(root);
    await mkdir(join(root, 'src/app/api/tasks'), { recursive: true });
    await writeFile(join(root, 'src/app/api/tasks/route.ts'), 'export async function GET() { return Response.json([]); }');
    const route = await observedRoute(root, 'tasks');
    const first = generate([route, ui('navigate'), ui('filter')]);
    expect(first.changes.added).toHaveLength(3);
    const before = JSON.stringify(first.state);
    await writeFile(join(root, 'src/app/api/tasks/route.ts'), 'export async function GET() { return Response.json({ tasks: [] }); }');
    const changed = { ...await observedRoute(root, 'tasks'), outputSchemaDigest: digest('F') };
    const second = generate([ui('navigate'), changed], first.state);
    expect(second.changes.changed).toHaveLength(1);
    expect(second.changes.removed).toHaveLength(1);
    expect(second.changes.unchanged).toHaveLength(1);
    expect(second.state.inventory.executions.find((item) => item.stableKey === route.stableKey)?.toolId)
      .toBe(first.state.inventory.executions.find((item) => item.stableKey === route.stableKey)?.toolId);
    expect(second.state.inventory.executions.some((item) => item.executionKind === 'ui' && item.actionId === 'filter')).toBe(false);
    expect(JSON.stringify(first.state)).toBe(before);
    expect(second.state.tombstones).toHaveLength(1);
  });

  it('is deterministic across source enumeration order and isolates app identities', () => {
    const first = generate([ui('navigate'), ui('filter')]);
    expect(generate([ui('filter'), ui('navigate')])).toEqual(first);
    const other = generate([ui('navigate'), ui('filter')], undefined, true, otherAppId);
    expect(other.state.inventory.executions.map((item) => item.toolId))
      .not.toEqual(first.state.inventory.executions.map((item) => item.toolId));
  });

  it('does not resurrect a removed identity with its former authorization', () => {
    const first = generate([ui('filter')]);
    const removed = generate([], first.state);
    const restored = generate([ui('filter')], removed.state);
    expect(restored.changes.added).toHaveLength(1);
    expect(restored.state.inventory.executions[0].toolId).not.toBe(first.state.inventory.executions[0].toolId);
    expect(restored.state.tombstones).toEqual(removed.state.tombstones);
  });

  it('refuses incomplete source snapshots rather than inferring deletions', () => {
    const first = generate([ui('filter')]);
    const before = JSON.stringify(first);
    expect(() => generate([], first.state, false)).toThrow('Source discovery is incomplete');
    expect(JSON.stringify(first)).toBe(before);
  });

  it('rejects cross-app prior state and duplicate source keys or names', () => {
    const first = generate([ui('filter')]);
    expect(() => generate([ui('filter')], first.state, true, otherAppId)).toThrow('different app');
    expect(() => generate([ui('filter'), ui('filter')])).toThrow('Duplicate');
    expect(() => generate([ui('filter'), { ...ui('navigate'), definitionId: 'ui.filter' }])).toThrow('Duplicate');
  });

  it('reports schema and binding changes without changing stable identity', () => {
    const first = generate([ui('filter')]);
    const next = generate([{ ...ui('filter'), inputSchemaDigest: digest('F'), actionId: 'filter.v2' }], first.state);
    expect(next.changes.changed).toEqual([first.state.inventory.executions[0].toolId]);
    expect(next.state.inventory.executions[0].toolId).toBe(first.state.inventory.executions[0].toolId);
    expect(next).not.toHaveProperty('policy');
    expect(next).not.toHaveProperty('enabled');
  });
});
