import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import ts from 'typescript';
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
  /**
   * The deterministic source that enumerated the endpoint. Absent on
   * inventories written before the tools generator; treated as next-app.
   */
  sourceKind: z.enum(['next-app']).optional(),
  sourceFile: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
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

async function verifyNextEndpoint(
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

  // A wrapper export (`export const GET = withAuth(…)`) exists even though the
  // reader cannot resolve its body; the fingerprint below still pins the file.
  const routeExports = readRouteExports(source, execution.sourceFile);
  const declared = routeExports.exports.some(({ method }) => method === execution.method)
    || routeExports.findings.some((finding) => (
      finding.code === 'route-export-unresolved' && finding.exportName === execution.method
    ));
  if (!declared) {
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

async function verifyEndpoint(
  rootDir: string,
  execution: z.infer<typeof endpointExecution>,
): Promise<DiscoveredFoundationExecution> {
  const kind = execution.sourceKind ?? 'next-app';
  if (kind === 'next-app') return verifyNextEndpoint(rootDir, execution);
  throw new Error(`Unsupported endpoint source kind: ${String(kind)}`);
}

/**
 * Read literal registrations from syntax, never comments or example strings.
 * This is source evidence, not proof that the component mounts at runtime.
 */
function registeredActionIds(source: string, fileName: string): Set<string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hooks = new Map<string, number>([['useAiClientAction', 0], ['useAiClientActionById', 1]]);
  const aliases = new Map(hooks);
  const namespaces = new Set<string>();
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || node.moduleSpecifier.text !== 'glirastes/react' || node.importClause?.isTypeOnly) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) {
        const argument = hooks.get((entry.propertyName ?? entry.name).text);
        if (!entry.isTypeOnly && argument !== undefined) aliases.set(entry.name.text, argument);
      }
    }
  }
  const ids = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const argument = ts.isIdentifier(callee) ? aliases.get(callee.text)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && namespaces.has(callee.expression.text) ? hooks.get(callee.name.text) : undefined;
      const value = argument === undefined ? undefined : node.arguments[argument];
      if (value && ts.isStringLiteralLike(value)) ids.add(value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return ids;
}

/** Index once per discovery, not once per UI tool. Generated files are mirrors. */
async function findActionHandlers(rootDir: string): Promise<Map<string, string>> {
  const matches = new Map<string, string>();

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
      if (!source.includes('useAiClientAction')) continue;
      for (const actionId of registeredActionIds(source, next)) {
        const previous = matches.get(actionId);
        if (!previous || next < previous) matches.set(actionId, next);
      }
    }
  };

  await walk('');
  return matches;
}

export async function discoverFoundationExecutions(options: {
  rootDir: string;
  inventory: unknown;
}): Promise<FoundationExecutionDiscovery> {
  const parsed = FoundationExecutionInventorySchema.parse(options.inventory);
  assertUniqueInventory(parsed);
  const inventory = canonicalInventory(parsed);
  const executions: DiscoveredFoundationExecution[] = [];
  const handlers = inventory.executions.some((execution) => execution.executionKind === 'ui' && execution.actionId)
    ? await findActionHandlers(options.rootDir) : new Map<string, string>();

  const findings: Array<{ code: string; subjectRef: string }> = [];

  for (const execution of inventory.executions) {
    if (execution.executionKind === 'endpoint') {
      executions.push(await verifyEndpoint(options.rootDir, execution));
      continue;
    }
    const sourceFile = execution.actionId
      ? handlers.get(execution.actionId)
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
