import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { FoundationExecutionInventorySchema } from './execution-inventory.js';

const [endpoint, ui] = FoundationExecutionInventorySchema.shape.executions.element.options;
const ObservationSchema = z.discriminatedUnion('executionKind', [
  endpoint.omit({ toolId: true }), ui.omit({ toolId: true }),
]);
const SnapshotSchema = z.object({
  complete: z.boolean(), executions: z.array(ObservationSchema).max(5_000),
}).strict();
const TombstoneSchema = z.object({
  toolId: z.uuid(), stableKey: z.string().min(1).max(2_100),
  definitionId: z.string().min(1).max(200),
}).strict();

/** App-local generation state; never upload this source-bearing object. */
export const ExecutionGenerationStateSchema = z.object({
  schemaVersion: z.literal(1), appId: z.uuid(),
  inventory: FoundationExecutionInventorySchema,
  tombstones: z.array(TombstoneSchema).max(100_000),
}).strict();
export type ExecutionGenerationState = z.infer<typeof ExecutionGenerationStateSchema>;
export type ObservedExecution = z.infer<typeof ObservationSchema>;
export interface ExecutionGenerationResult {
  state: ExecutionGenerationState;
  changes: { added: string[]; changed: string[]; removed: string[]; unchanged: string[] };
}

function fail(message: string, remediation: string): never {
  throw new FoundationDiagnosticError({
    code: 'E-INVENTORY-010', operation: 'generate.inventory', message, remediation,
  });
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(value));
}

// UUIDv5 scoped to app + target + stable key + removal generation. Reappearance
// is a new identity, not revival of an old authorization/approval reference.
function newIdentity(appId: string, target: string, key: string, generation: number): string {
  const bytes = createHash('sha1').update(Buffer.from(appId.replaceAll('-', ''), 'hex'))
    .update(JSON.stringify(['glirastes.execution.v1', target, key, generation])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUnique(entries: ReadonlyArray<ObservedExecution>): void {
  const keys = new Set<string>();
  const names = new Set<string>();
  const fingerprints = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.stableKey) || names.has(entry.definitionId)) {
      fail('Duplicate execution keys or definition names.', 'repair-source-observations');
    }
    if (fingerprints.has(entry.sourceFingerprint)) {
      fail('Conflicting source fingerprint.', 'repair-source-observations');
    }
    if (entry.executionKind === 'endpoint' && entry.stableKey !== `${entry.method} ${entry.path}`) {
      fail('Endpoint stable key does not match its method and path.', 'repair-source-observations');
    }
    keys.add(entry.stableKey);
    names.add(entry.definitionId);
    fingerprints.add(entry.sourceFingerprint);
  }
}

/**
 * Reconcile a complete source-adapter snapshot. Does not assess semantics,
 * grant permissions, write files, sync, or claim executable-source verification.
 * Callers must persist state (including tombstones) and validate real sources.
 */
export function reconcileExecutionInventory(options: {
  appId: string; targetAppKey: string; observed: unknown; previous?: unknown;
}): ExecutionGenerationResult {
  const scope = z.object({ appId: z.uuid(), targetAppKey: z.string().trim().min(1).max(200) }).safeParse(options);
  const snapshot = SnapshotSchema.safeParse(options.observed);
  if (!scope.success || !snapshot.success) fail('Invalid generation scope or source observations.', 'repair-source-observations');
  if (!snapshot.data.complete) fail('Source discovery is incomplete; prior inventory was not replaced.', 'complete-source-discovery');
  const parsed = options.previous === undefined ? undefined : ExecutionGenerationStateSchema.safeParse(options.previous);
  if (parsed && !parsed.success) fail('Invalid previous generation state.', 'restore-generation-state');
  const previous = parsed?.data;
  if (previous && (previous.appId !== scope.data.appId || previous.inventory.targetAppKey !== scope.data.targetAppKey)) {
    fail('Previous generation state belongs to a different app.', 'align-generation-scope');
  }
  assertUnique(snapshot.data.executions);
  assertUnique(previous?.inventory.executions ?? []);
  const occupied = new Set<string>();
  for (const entry of [...previous?.inventory.executions ?? [], ...previous?.tombstones ?? []]) {
    if (occupied.has(entry.toolId)) fail('Duplicate identities in previous generation state.', 'restore-generation-state');
    occupied.add(entry.toolId);
  }
  const previousByKey = new Map(previous?.inventory.executions.map((entry) => [entry.stableKey, entry]));
  const currentKeys = new Set(snapshot.data.executions.map(({ stableKey }) => stableKey));
  const tombstones = [...previous?.tombstones ?? []];
  const changes: ExecutionGenerationResult['changes'] = { added: [], changed: [], removed: [], unchanged: [] };
  for (const old of previous?.inventory.executions ?? []) {
    if (currentKeys.has(old.stableKey)) continue;
    changes.removed.push(old.toolId);
    tombstones.push({ toolId: old.toolId, stableKey: old.stableKey, definitionId: old.definitionId });
  }
  const executions = snapshot.data.executions.map((observation) => {
    const old = previousByKey.get(observation.stableKey);
    const toolId = old?.toolId ?? newIdentity(scope.data.appId, scope.data.targetAppKey, observation.stableKey,
      tombstones.filter(({ stableKey }) => stableKey === observation.stableKey).length);
    if (!old && occupied.has(toolId)) fail('Generated execution identity conflicts with previous state.', 'restore-generation-state');
    occupied.add(toolId);
    const execution = { ...observation, toolId };
    changes[!old ? 'added' : canonical(old) === canonical(execution) ? 'unchanged' : 'changed'].push(toolId);
    return execution;
  }).sort((a, b) => a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0);
  for (const list of Object.values(changes)) list.sort();
  tombstones.sort((a, b) => a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0);
  return {
    state: ExecutionGenerationStateSchema.parse({ schemaVersion: 1, appId: scope.data.appId,
      inventory: { schemaVersion: 2, targetAppKey: scope.data.targetAppKey, executions }, tombstones }),
    changes,
  };
}
