import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createRouteSourceFingerprint } from './route-fingerprint.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);

const executionBase = z.object({
  toolId: uuid,
  definitionId: identifier,
  stableKey: z.string().trim().min(1).max(2_100),
  sourceFingerprint: digest,
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
});

const endpointExecution = executionBase.extend({
  executionKind: z.literal('endpoint'),
  sourceFile: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
}).strict();

const uiExecution = executionBase.extend({
  executionKind: z.literal('ui'),
  actionBindingRef: identifier,
}).strict();

export const FoundationExecutionInventorySchema = z.object({
  schemaVersion: z.literal(2),
  targetAppKey: identifier,
  executions: z.array(z.discriminatedUnion('executionKind', [
    endpointExecution,
    uiExecution,
  ])).max(5_000),
}).strict();

export type FoundationExecutionInventory = z.infer<
  typeof FoundationExecutionInventorySchema
>;

export type DiscoveredFoundationExecution =
  FoundationExecutionInventory['executions'][number] & {
    sourceLocator:
      | { sourceFile: string; exportName: string }
      | { actionBindingRef: string };
  };

export interface FoundationExecutionDiscovery {
  schemaVersion: 2;
  targetAppKey: string;
  inventoryDigest: string;
  executions: DiscoveredFoundationExecution[];
  findings: [];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function canonicalInventory(
  inventory: FoundationExecutionInventory,
): FoundationExecutionInventory {
  return {
    ...inventory,
    executions: [...inventory.executions]
      .sort((left, right) => left.toolId.localeCompare(right.toolId)),
  };
}

function assertUniqueInventory(
  inventory: FoundationExecutionInventory,
): void {
  const toolIds = new Set<string>();
  const stableKeys = new Set<string>();
  const fingerprints = new Map<string, string>();

  for (const execution of inventory.executions) {
    if (toolIds.has(execution.toolId)) {
      throw new Error('Foundation inventory contains a duplicate tool UUID');
    }
    if (stableKeys.has(execution.stableKey)) {
      throw new Error('Foundation inventory contains a duplicate stable key');
    }
    const fingerprintOwner = fingerprints.get(execution.sourceFingerprint);
    if (fingerprintOwner && fingerprintOwner !== execution.stableKey) {
      throw new Error(
        'Foundation inventory contains a conflicting source fingerprint',
      );
    }
    toolIds.add(execution.toolId);
    stableKeys.add(execution.stableKey);
    fingerprints.set(execution.sourceFingerprint, execution.stableKey);
  }
}

async function verifyEndpoint(
  rootDir: string,
  execution: z.infer<typeof endpointExecution>,
): Promise<DiscoveredFoundationExecution> {
  let source: string;
  try {
    source = await readFile(resolve(rootDir, execution.sourceFile), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Foundation inventory references a missing route: ${execution.stableKey}`,
      );
    }
    throw error;
  }

  const exportPattern = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${execution.method}\\b`,
  );
  if (!exportPattern.test(source)) {
    throw new Error(
      `Foundation inventory references a missing route export: ${execution.stableKey}`,
    );
  }

  const expectedStableKey = `${execution.method} ${execution.path}`;
  if (execution.stableKey !== expectedStableKey) {
    throw new Error(
      `Foundation inventory stable key mismatch: ${execution.stableKey}`,
    );
  }

  const currentFingerprint = createRouteSourceFingerprint(
    source,
    execution.method,
    execution.path,
  );
  if (currentFingerprint !== execution.sourceFingerprint) {
    throw new Error(
      `Foundation route fingerprint mismatch: ${execution.stableKey}`,
    );
  }

  return {
    ...execution,
    sourceLocator: {
      sourceFile: execution.sourceFile,
      exportName: execution.method,
    },
  };
}

export async function discoverFoundationExecutions(options: {
  rootDir: string;
  inventory: unknown;
}): Promise<FoundationExecutionDiscovery> {
  const parsed = FoundationExecutionInventorySchema.parse(options.inventory);
  assertUniqueInventory(parsed);
  const inventory = canonicalInventory(parsed);
  const executions: DiscoveredFoundationExecution[] = [];

  for (const execution of inventory.executions) {
    executions.push(execution.executionKind === 'endpoint'
      ? await verifyEndpoint(options.rootDir, execution)
      : {
        ...execution,
        sourceLocator: {
          actionBindingRef: execution.actionBindingRef,
        },
      });
  }

  const canonicalJson = JSON.stringify(canonicalValue(inventory));
  return {
    schemaVersion: 2,
    targetAppKey: inventory.targetAppKey,
    inventoryDigest: `sha256:${createHash('sha256')
      .update(canonicalJson)
      .digest('base64url')}`,
    executions,
    findings: [],
  };
}
