import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
  type FoundationExecutionInventory,
} from './execution-inventory.js';
import { operationFingerprint, operationsOf, parseOpenapiDocument } from './openapi-document.js';
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
  it.each([
    'export const GET = async () => Response.json([]);',
    'const handler = async () => Response.json([]); export { handler as GET };',
  ])('accepts the same local constant and aliased exports as the scanner', async (source) => {
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [endpoint({ source })] },
    });
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].sourceLocator).toMatchObject({ exportName: 'GET' });
  });

  it('does not accept a removed export preserved only in a comment', async () => {
    const source = '// export async function GET() {}';
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [endpoint({ source })] },
    })).rejects.toThrow(/missing route export/);
  });

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

  it.each([
    `import { useAiClientAction } from 'glirastes/react';
     function View() { useAiClientAction(\n 'task-details.open', () => {}); }`,
    `import { useAiClientAction as register } from 'glirastes/react';
     function View() { register('task-details.open', () => {}); }`,
    `import * as ui from 'glirastes/react';
     function View() { ui.useAiClientAction('task-details.open', () => {}); }`,
    `import { useAiClientActionById as register } from 'glirastes/react';
     function View() { register(bus, 'task-details.open', () => {}); }`,
  ])('recognizes a real hook call regardless of formatting or import alias', async (source) => {
    const rootDir = await fixture({ 'src/view.tsx': source });
    const discovery = await discoverFoundationExecutions({ rootDir, inventory: uiInventory() });
    expect(discovery.findings).toEqual([]);
    expect(discovery.executions[0].sourceLocator).toMatchObject({ sourceFile: 'src/view.tsx' });
  });

  it.each([
    `// useAiClientAction('task-details.open', () => {});`,
    `const example = "useAiClientAction('task-details.open', () => {})";`,
  ])('does not accept an example or commented-out handler as live source', async (source) => {
    const rootDir = await fixture({ 'src/view.tsx': source });
    const discovery = await discoverFoundationExecutions({ rootDir, inventory: uiInventory() });
    expect(discovery.findings).toContainEqual(expect.objectContaining({ code: 'ui-action-handler-not-found' }));
  });

  it('indexes multiple registrations with deterministic source selection', async () => {
    const rootDir = await fixture({
      'src/z.tsx': handler,
      'src/a.tsx': handler,
      'src/filter.tsx': `import { useAiClientAction as register } from 'glirastes/react';
        function Filters() { register('tasks.filter', () => {}); }`,
    });
    const inventory = uiInventory();
    inventory.executions.push({ ...inventory.executions[0], toolId: id('902'),
      definitionId: 'ui.tasks.filter', stableKey: 'UI ui.tasks.filter', executionKind: 'ui',
      sourceFingerprint: digest('B'), actionBindingRef: 'ui.tasks.filter', actionId: 'tasks.filter' });
    const discovery = await discoverFoundationExecutions({ rootDir, inventory });
    expect(discovery.findings).toEqual([]);
    expect(discovery.executions.map(({ sourceLocator }) => sourceLocator)).toEqual([
      { actionBindingRef: 'ui.taskDetails.open', sourceFile: 'src/a.tsx' },
      { actionBindingRef: 'ui.tasks.filter', sourceFile: 'src/filter.tsx' },
    ]);
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

describe('endpoint source kinds', () => {
  it('verifies a wrapper-exported handler the route reader cannot resolve to a body', async () => {
    const source = 'import { withAuth } from "@/lib/auth";\n'
      + 'export const GET = withAuth(async () => Response.json([]));\n';
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    const base = endpoint({ source });
    if (base.executionKind !== 'endpoint') throw new Error('expected endpoint');
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [{ ...base, sourceKind: 'next-app' as const }],
      },
    });
    expect(result.executions[0]).toMatchObject({
      sourceKind: 'next-app',
      sourceLocator: { exportName: 'GET' },
    });
  });

  it('still rejects a method the route does not declare', async () => {
    const source = 'export const POST = withAuth(async () => Response.json([]));\n';
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [endpoint({ source })] },
    })).rejects.toThrow(/missing route export/);
  });

  const NEST_CONTROLLER = "import { Controller, Get } from '@nestjs/common';\n"
    + "@Controller('tasks')\nexport class TasksController {\n  @Get()\n  list() {\n    return [];\n  }\n}\n";

  it('verifies a Nest controller method by its decorator and fingerprint', async () => {
    const rootDir = await fixture({ 'src/tasks.controller.ts': NEST_CONTROLLER });
    const base = endpoint({ source: NEST_CONTROLLER, sourceFile: 'src/tasks.controller.ts' });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [{ ...base, sourceKind: 'nest' as const }] },
    });
    expect(result.executions[0]).toMatchObject({
      sourceKind: 'nest',
      sourceLocator: { sourceFile: 'src/tasks.controller.ts', exportName: 'GET' },
    });
  });

  it.each([
    ['a namespace import', "import * as common from '@nestjs/common';\n"
      + "@common.Controller('tasks')\nexport class TasksController {\n  @common.Get()\n  list() {\n    return [];\n  }\n}\n"],
    ['an aliased named import', "import { Controller as C, Get as G } from '@nestjs/common';\n"
      + "@C('tasks')\nexport class TasksController {\n  @G()\n  list() {\n    return [];\n  }\n}\n"],
  ])('verifies a Nest controller decorated through %s', async (_label, source) => {
    const rootDir = await fixture({ 'src/tasks.controller.ts': source });
    const base = endpoint({ source, sourceFile: 'src/tasks.controller.ts' });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [{ ...base, sourceKind: 'nest' as const }] },
    });
    expect(result.executions[0]).toMatchObject({ sourceKind: 'nest', sourceLocator: { exportName: 'GET' } });
  });

  it('rejects a Nest method decorator from a namespace that is not @nestjs/common', async () => {
    const source = "import * as other from 'other-lib';\n"
      + "@other.Controller('tasks')\nexport class TasksController {\n  @other.Get()\n  list() {\n    return [];\n  }\n}\n";
    const rootDir = await fixture({ 'src/tasks.controller.ts': source });
    const base = endpoint({ source, sourceFile: 'src/tasks.controller.ts' });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [{ ...base, sourceKind: 'nest' as const }] },
    })).rejects.toThrow(/missing controller method/);
  });

  it.each([
    ['the method decorator is gone', NEST_CONTROLLER.replace('@Get()', '@Post()').replace('{ Controller, Get }', '{ Controller, Post }'), /missing controller method/],
    ['the controller changed', NEST_CONTROLLER.replace('return []', 'return [1]'), /fingerprint mismatch/],
  ])('fails closed for a Nest endpoint when %s', async (_label, current, error) => {
    const rootDir = await fixture({ 'src/tasks.controller.ts': current });
    const base = endpoint({ source: NEST_CONTROLLER, sourceFile: 'src/tasks.controller.ts' });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [{ ...base, sourceKind: 'nest' as const }] },
    })).rejects.toThrow(error);
  });

  const OPENAPI = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Tasks', version: '1' },
    paths: { '/api/tasks': { get: { security: [{ APIKeyCookie: [] }], responses: { '200': { description: 'Tasks' } } } } },
  });

  function openapiExecution(document: string) {
    const parsed = parseOpenapiDocument(document);
    if (!parsed.ok) throw new Error(parsed.reason);
    const [operation] = operationsOf(parsed.document);
    return {
      ...endpoint({ source: document, sourceFile: 'api/openapi.json' }),
      sourceKind: 'openapi',
      sourceFingerprint: operationFingerprint(parsed.document, operation!, 'GET', '/api/tasks'),
    };
  }

  it('verifies an OpenAPI operation by its path, method and fingerprint', async () => {
    const rootDir = await fixture({ 'api/openapi.json': OPENAPI });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [openapiExecution(OPENAPI)] },
    });
    expect(result.executions[0]).toMatchObject({
      sourceKind: 'openapi',
      sourceLocator: { sourceFile: 'api/openapi.json', exportName: 'GET' },
    });
  });

  it.each([
    ['the operation is gone', OPENAPI.replace('"get"', '"post"'), /missing OpenAPI operation/],
    ['the operation changed', OPENAPI.replace('"Tasks"}', '"Open tasks"}'), /fingerprint mismatch/],
  ])('fails closed for an OpenAPI endpoint when %s', async (_label, current, error) => {
    expect(current).not.toBe(OPENAPI);
    const rootDir = await fixture({ 'api/openapi.json': current });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [openapiExecution(OPENAPI)] },
    })).rejects.toThrow(error);
  });

  it('rejects unknown endpoint source kinds', () => {
    const parsed = FoundationExecutionInventorySchema.safeParse({
      schemaVersion: 2,
      targetAppKey: 'fixture',
      executions: [{ ...endpoint({ source: 'x' }), sourceKind: 'rails' }],
    });
    expect(parsed.success).toBe(false);
  });
});
