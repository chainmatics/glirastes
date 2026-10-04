import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileExecutionInventory } from '../inventory-generation.js';
import { canonicalJson } from './canonical.js';
import { ToolsConfigSchema } from './config.js';
import {
  readPreviousToolState,
  renderInventory,
  renderTombstones,
  splitMergeConflict,
  ToolStateError,
} from './state.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const TOOL_A = '019fb007-0000-7000-8000-0000000000b1';
const TOOL_B = '019fb007-0000-7000-8000-0000000000b2';
const TOOL_C = '019fb007-0000-7000-8000-0000000000b3';
const config = ToolsConfigSchema.parse({
  schemaVersion: 1, appId: APP_ID, targetAppKey: 'fixture', locale: 'en-US', sources: ['next-app'],
});
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const roots: string[] = [];

function execution(toolId: string, stableKey: string, definitionId: string) {
  const [method, path] = stableKey.split(' ') as ['GET', string];
  return {
    toolId,
    definitionId,
    stableKey,
    executionKind: 'endpoint' as const,
    sourceKind: 'next-app' as const,
    sourceFile: `src/app${path}/route.ts`,
    method,
    path,
    sourceFingerprint: `sha256:${createHash('sha256').update(stableKey).digest('base64url')}`,
    inputSchemaDigest: digest('A'),
    outputSchemaDigest: digest('B'),
  };
}

function inventory(executions: unknown[]) {
  return { schemaVersion: 2, targetAppKey: 'fixture', executions };
}

function tombstones(entries: Array<{ toolId: string; stableKey: string; definitionId: string }>) {
  return { schemaVersion: 1, appId: APP_ID, tombstones: entries };
}

/** A realistic git hunk conflict between two canonical JSON files. */
function conflict(ours: string, theirs: string): string {
  const left = ours.split('\n');
  const right = theirs.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (
    end < left.length - start && end < right.length - start
    && left[left.length - 1 - end] === right[right.length - 1 - end]
  ) end += 1;
  return [
    ...left.slice(0, start),
    '<<<<<<< HEAD',
    ...left.slice(start, left.length - end),
    '=======',
    ...right.slice(start, right.length - end),
    '>>>>>>> feature',
    ...left.slice(left.length - end),
  ].join('\n');
}

function artifact(riskClass: 'safe-read' | 'write') {
  return {
    schemaVersion: 1,
    artifactId: '019fb007-0000-7000-8000-0000000000c1',
    runId: '019fb007-0000-7000-8000-0000000000c2',
    appId: APP_ID,
    discoveryDigest: digest('D'),
    assessmentMode: 'autonomous',
    status: 'ready',
    tools: [{
      toolId: TOOL_A,
      sourceFingerprint: digest('F'),
      name: 'tasks.list',
      description: 'List tasks.',
      modelName: 'tasks_list',
      module: 'tasks',
      sharedWith: [],
      usageHints: ['List tasks.'],
      presentation: { locale: 'en-US', singular: 'List tasks', plural: 'List tasks', approval: 'List tasks' },
      executionKind: 'endpoint',
      method: 'GET',
      path: '/api/tasks',
      operationGroup: 'read',
      riskClass,
      enabled: true,
      requiresApproval: riskClass === 'write',
      inputSchemaDigest: digest('A'),
      outputSchemaDigest: digest('B'),
    }],
    planner: {
      plannerId: '019fb007-0000-7000-8000-0000000000c3',
      modelBindingRef: 'default',
      promptBindingRef: 'prompt:fixture',
      budgetProfileRef: 'default',
      toolIds: [TOOL_A],
    },
    prompts: {
      bundleDigest: digest('E'),
      artifactRef: 'local://fixture/prompts',
      plannerDigest: digest('G'),
      appBehaviorDigest: digest('H'),
      responseStyleDigest: digest('I'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-04T08:00:00.000Z',
  };
}

function contracts(bindingInterfaceDigest: string) {
  return {
    schemaVersion: 1,
    appId: APP_ID,
    tools: [{
      toolId: TOOL_A,
      stableKey: 'GET /api/tasks',
      definitionId: 'tasks.list',
      contract: {
        source: 'contract-module',
        loadBearing: false,
        input: { type: 'object' },
        output: {},
        params: { path: [], query: [], body: [] },
        interfaceDigest: digest('N'),
        runtime: { input: { kind: 'json', schema: { type: 'object' } }, output: { kind: 'json', schema: {} } },
        binding: { interfaceDigest: bindingInterfaceDigest, contractModuleDigest: digest('M') },
      },
      defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    }],
  };
}

async function app(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-tool-state-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('previous tool state', () => {
  it('is empty for a fresh app', async () => {
    const state = await readPreviousToolState(await app({}), config);
    expect(state.state).toBeUndefined();
    expect(state.artifact).toBeUndefined();
    expect(state.contracts.size).toBe(0);
  });

  it('combines the inventory and the tombstone file into one generation state', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': canonicalJson(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
      '.glirastes/tool-tombstones.json': canonicalJson(tombstones([{ toolId: TOOL_A, stableKey: 'GET /api/old', definitionId: 'old.list' }])),
      '.glirastes/setup-receipt.json': JSON.stringify({ mode: 'managed' }),
    });
    const state = await readPreviousToolState(root, config);
    expect(state.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_B]);
    expect(state.state?.tombstones.map((entry) => entry.toolId)).toEqual([TOOL_A]);
    expect(state.receiptMode).toBe('managed');
  });

  it('resolves a merge conflict without reviving a tombstoned identity', async () => {
    const ours = canonicalJson(inventory([execution(TOOL_A, 'GET /api/tasks', 'tasks.list')]));
    const theirs = canonicalJson(inventory([
      execution(TOOL_B, 'GET /api/tasks', 'tasks.list'),
      execution(TOOL_C, 'GET /api/notes', 'notes.list'),
    ]));
    const marked = conflict(ours, theirs);
    expect(splitMergeConflict(marked)).toEqual([ours, theirs]);
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': marked,
      '.glirastes/tool-tombstones.json': canonicalJson(tombstones([{ toolId: TOOL_A, stableKey: 'GET /api/tasks', definitionId: 'tasks.list' }])),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_B, TOOL_C]);
    const observed = previous.state!.inventory.executions.map(({ toolId: _toolId, ...rest }) => rest);
    const next = reconcileExecutionInventory({
      appId: APP_ID, targetAppKey: 'fixture', previous: previous.state, observed: { complete: true, executions: observed },
    });
    expect(next.state.inventory.executions.find((entry) => entry.stableKey === 'GET /api/tasks')?.toolId).toBe(TOOL_B);
    expect(next.state.tombstones.map((entry) => entry.toolId)).toContain(TOOL_A);
  });

  it('keeps the smaller identity and tombstones the other when both sides are live', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': conflict(
        canonicalJson(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
        canonicalJson(inventory([execution(TOOL_A, 'GET /api/tasks', 'tasks.list')])),
      ),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_A]);
    expect(previous.state?.tombstones.map((entry) => entry.toolId)).toEqual([TOOL_B]);
  });

  it('drops the later of two keys that merged onto the same definition id', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': conflict(
        canonicalJson(inventory([execution(TOOL_A, 'PATCH /api/tasks', 'tasks.update')])),
        canonicalJson(inventory([execution(TOOL_B, 'PUT /api/tasks', 'tasks.update')])),
      ),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.stableKey)).toEqual(['PATCH /api/tasks']);
  });

  it('keeps the managed receipt mode across a merge conflict', async () => {
    const root = await app({
      '.glirastes/setup-receipt.json': conflict(
        `${JSON.stringify({ schemaVersion: 1, mode: 'standalone' }, null, 2)}\n`,
        `${JSON.stringify({ schemaVersion: 1, mode: 'managed' }, null, 2)}\n`,
      ),
    });
    expect((await readPreviousToolState(root, config)).receiptMode).toBe('managed');
  });

  it('reports unreadable or foreign state with the offending path', async () => {
    await expect(readPreviousToolState(await app({ '.glirastes/foundation-execution-inventory.json': '{' }), config))
      .rejects.toEqual(expect.objectContaining({ name: 'ToolStateError', path: '.glirastes/foundation-execution-inventory.json' }));
    await expect(readPreviousToolState(await app({
      '.glirastes/foundation-execution-inventory.json': JSON.stringify({ ...inventory([]), targetAppKey: 'other' }),
    }), config)).rejects.toBeInstanceOf(ToolStateError);
    await expect(readPreviousToolState(await app({
      '.glirastes/tool-tombstones.json': JSON.stringify({ ...tombstones([]), appId: '019fb007-0000-7000-8000-0000000000ff' }),
    }), config)).rejects.toBeInstanceOf(ToolStateError);
  });

  it('adopts an explicit inventory instead of the committed one', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': canonicalJson(inventory([])),
      'pilot/inventory.json': canonicalJson(inventory([execution(TOOL_C, 'GET /api/notes', 'notes.list')])),
    });
    const previous = await readPreviousToolState(root, config, { adoptInventoryPath: 'pilot/inventory.json' });
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_C]);
  });

  it('keeps the strictest previous risk and the stale contract binding across a conflict', async () => {
    const root = await app({
      '.glirastes/setup-artifact.json': conflict(canonicalJson(artifact('safe-read')), canonicalJson(artifact('write'))),
      '.glirastes/tool-contracts.json': conflict(canonicalJson(contracts(digest('N'))), canonicalJson(contracts(digest('O')))),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.artifact?.artifact).toBeUndefined();
    expect(previous.artifact?.riskByToolId.get(TOOL_A)).toBe('write');
    expect(previous.artifact?.planner?.plannerId).toBe('019fb007-0000-7000-8000-0000000000c3');
    expect(previous.contracts.get('GET /api/tasks')?.binding?.interfaceDigest).toBe(digest('O'));
  });

  it('renders inventory and tombstones canonically', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': JSON.stringify(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
      '.glirastes/tool-tombstones.json': JSON.stringify(tombstones([])),
    });
    const { state } = await readPreviousToolState(root, config);
    expect(renderInventory(state!)).toBe(canonicalJson(state!.inventory));
    expect(renderTombstones(state!)).toBe(canonicalJson({ schemaVersion: 1, appId: APP_ID, tombstones: [] }));
  });
});
