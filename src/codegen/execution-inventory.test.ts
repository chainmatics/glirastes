import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverFoundationExecutions,
  type FoundationExecutionInventory,
} from './execution-inventory.js';
import { createRouteSourceFingerprint } from './route-scanner.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de1e${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function fixture(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-inventory-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  return rootDir;
}

function endpoint(options: {
  source: string;
  definitionId?: string;
  toolId?: string;
  path?: string;
  sourceFile?: string;
}): FoundationExecutionInventory['executions'][number] {
  const path = options.path ?? '/api/tasks';
  return {
    toolId: options.toolId ?? id('1'),
    definitionId: options.definitionId ?? 'tasks.list',
    stableKey: `GET ${path}`,
    executionKind: 'endpoint',
    sourceFile: options.sourceFile ?? 'src/app/api/tasks/route.ts',
    sourceFingerprint: createRouteSourceFingerprint(
      options.source,
      'GET',
      path,
    ),
    inputSchemaDigest: digest('A'),
    outputSchemaDigest: digest('B'),
    method: 'GET',
    path,
  };
}

describe('discoverFoundationExecutions', () => {
  it('discovers only the positive inventory even when comments say otherwise', async () => {
    const listed = `
      // @ai-ignore
      export async function GET() { return Response.json([]); }
    `;
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': listed,
      'src/app/api/internal/route.ts':
        'export async function GET() { return Response.json({ ok: true }); }',
    });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [endpoint({ source: listed })],
      },
    });

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({
      toolId: id('1'),
      stableKey: 'GET /api/tasks',
      sourceLocator: {
        sourceFile: 'src/app/api/tasks/route.ts',
        exportName: 'GET',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/api/internal');
    expect(result.inventoryDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it('keeps tool identity when a definition label changes', async () => {
    const source = 'export async function GET() { return Response.json([]); }';
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': source,
    });
    const sharedToolId = id('7');
    const first = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [endpoint({
          source,
          toolId: sharedToolId,
          definitionId: 'tasks.list',
        })],
      },
    });
    const renamed = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [endpoint({
          source,
          toolId: sharedToolId,
          definitionId: 'tasks.listVisible',
        })],
      },
    });

    expect(renamed.executions[0]?.toolId)
      .toBe(first.executions[0]?.toolId);
  });

  it.each([
    ['duplicate tool UUID', (source: string) => [
      endpoint({ source }),
      endpoint({
        source,
        definitionId: 'tasks.listAgain',
        path: '/api/tasks-again',
        sourceFile: 'src/app/api/tasks-again/route.ts',
      }),
    ]],
    ['duplicate stable key', (source: string) => [
      endpoint({ source }),
      endpoint({ source, toolId: id('2'), definitionId: 'tasks.other' }),
    ]],
  ])('fails closed for a %s', async (_label, executions) => {
    const source = 'export async function GET() { return Response.json([]); }';
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': source,
      'src/app/api/tasks-again/route.ts': source,
    });

    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: executions(source),
      },
    })).rejects.toThrow(/duplicate/i);
  });

  it('fails closed for a stale route entry', async () => {
    const source = 'export async function GET() { return Response.json([]); }';
    const rootDir = await fixture({});

    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [endpoint({ source })],
      },
    })).rejects.toThrow(/missing route/i);
  });

  it('fails closed when the route fingerprint changed', async () => {
    const inventorySource =
      'export async function GET() { return Response.json([]); }';
    const currentSource =
      'export async function GET() { return Response.json([1]); }';
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': currentSource,
    });

    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [endpoint({ source: inventorySource })],
      },
    })).rejects.toThrow(/fingerprint/i);
  });

  it('emits byte-stable ordering and digests', async () => {
    const source = 'export async function GET() { return Response.json([]); }';
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': source,
      'src/app/api/tasks-2/route.ts': source,
    });
    const left = endpoint({ source, toolId: id('2') });
    const right = endpoint({
      source,
      toolId: id('1'),
      definitionId: 'tasks.listSecond',
      path: '/api/tasks-2',
      sourceFile: 'src/app/api/tasks-2/route.ts',
    });

    const first = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [left, right],
      },
    });
    const second = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [right, left],
      },
    });

    expect(first).toEqual(second);
    expect(first.executions.map((execution) => execution.toolId))
      .toEqual([id('1'), id('2')]);
  });
});

describe('resolving a UI action to its handler', () => {
  const uiInventory = (
    overrides: Record<string, unknown> = {},
  ): FoundationExecutionInventory => ({
    schemaVersion: 2,
    targetAppKey: 'get-it-done',
    executions: [{
      toolId: id('901'),
      definitionId: 'ui.taskDetails.open',
      stableKey: 'UI ui.taskDetails.open',
      executionKind: 'ui',
      actionBindingRef: 'ui.taskDetails.open',
      actionId: 'task-details.open',
      sourceFingerprint: digest('A'),
      inputSchemaDigest: digest('B'),
      outputSchemaDigest: digest('C'),
      ...overrides,
    }],
  } as FoundationExecutionInventory);

  const handler = `
    import { useAiClientAction } from 'glirastes/react';
    export function TaskListView() {
      useAiClientAction('task-details.open', (payload) => open(payload.id));
      return null;
    }
  `;

  /**
   * A UI action carried only its binding reference, so an assessment had no
   * source to read and had to guess side effects from the name. The handler
   * registration is the evidence, and it is findable by the action id.
   */
  it('records the file that registers the action', async () => {
    const rootDir = await fixture({
      'src/components/tasks/task-list-view.tsx': handler,
    });

    const discovery = await discoverFoundationExecutions({
      rootDir,
      inventory: uiInventory(),
    });

    expect(discovery.executions[0].sourceLocator).toMatchObject({
      sourceFile: 'src/components/tasks/task-list-view.tsx',
      actionBindingRef: 'ui.taskDetails.open',
    });
  });

  it('reports an action whose handler is nowhere registered', async () => {
    const rootDir = await fixture({
      'src/components/tasks/task-list-view.tsx': handler,
    });

    const discovery = await discoverFoundationExecutions({
      rootDir,
      inventory: uiInventory({ actionId: 'never-registered' }),
    });

    expect(discovery.findings).toContainEqual(
      expect.objectContaining({ code: 'ui-action-handler-not-found' }),
    );
  });

  /** Without an action id there is nothing to search for, and that is fine. */
  it('still accepts an entry that declares no action id', async () => {
    const rootDir = await fixture({ 'src/a.tsx': handler });
    const inventory = uiInventory();
    delete (inventory.executions[0] as Record<string, unknown>).actionId;

    const discovery = await discoverFoundationExecutions({ rootDir, inventory });

    expect(discovery.executions[0].sourceLocator).toMatchObject({
      actionBindingRef: 'ui.taskDetails.open',
    });
  });
});
