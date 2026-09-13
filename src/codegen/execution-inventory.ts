import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createRouteSourceFingerprint } from './route-fingerprint.js';
import { readRouteExports } from './route-exports.js';

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
  /**
   * The identifier the client handler registers with. It differs from the
   * definition id, and it is the only way to find the code that actually runs
   * an action, so an assessment can read it instead of guessing from a name.
   */
  actionId: identifier.optional(),
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
      | { actionBindingRef: string; sourceFile?: string };
  };

export interface FoundationExecutionDiscovery {
  schemaVersion: 2;
  targetAppKey: string;
  inventoryDigest: string;
  executions: DiscoveredFoundationExecution[];
  findings: Array<{ code: string; subjectRef: string }>;
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

  if (!readRouteExports(source).exports.some(({ method }) => method === execution.method)) {
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

/**
 * Locate the client handler that registers an action.
 *
 * The registration is a literal call with the action id, so a textual search
 * is enough and stays deterministic. Generated files are skipped: they mirror
 * the inventory rather than implementing behaviour.
 */
async function findActionHandler(
  rootDir: string,
  actionId: string,
): Promise<string | null> {
  const needle = `useAiClientAction('${actionId}'`;
  const alternate = `useAiClientAction("${actionId}"`;
  const matches: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(resolve(rootDir, relative), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (entry.name === 'generated') continue;
        await walk(next);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      const source = await readFile(resolve(rootDir, next), 'utf8')
        .catch(() => '');
      if (source.includes(needle) || source.includes(alternate)) {
        matches.push(next);
      }
    }
  };

  await walk('');
  return matches.sort()[0] ?? null;
}

export async function discoverFoundationExecutions(options: {
  rootDir: string;
  inventory: unknown;
}): Promise<FoundationExecutionDiscovery> {
  const parsed = FoundationExecutionInventorySchema.parse(options.inventory);
  assertUniqueInventory(parsed);
  const inventory = canonicalInventory(parsed);
  const executions: DiscoveredFoundationExecution[] = [];

  const findings: Array<{ code: string; subjectRef: string }> = [];

  for (const execution of inventory.executions) {
    if (execution.executionKind === 'endpoint') {
      executions.push(await verifyEndpoint(options.rootDir, execution));
      continue;
    }
    const sourceFile = execution.actionId
      ? await findActionHandler(options.rootDir, execution.actionId)
      : null;
    if (execution.actionId && !sourceFile) {
      findings.push({
        code: 'ui-action-handler-not-found',
        subjectRef: execution.definitionId,
      });
    }
    executions.push({
      ...execution,
      sourceLocator: {
        actionBindingRef: execution.actionBindingRef,
        ...(sourceFile ? { sourceFile } : {}),
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
    findings,
  };
}
