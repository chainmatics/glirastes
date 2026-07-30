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
