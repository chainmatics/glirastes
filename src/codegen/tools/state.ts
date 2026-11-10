import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import {
  AppSetupArtifactSchema,
  type AppSetupArtifact,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { riskTier } from '../../contracts/tool-policy.js';
import {
  FoundationExecutionInventorySchema,
  type FoundationExecutionInventory,
} from '../execution-inventory.js';
import {
  ExecutionGenerationStateSchema,
  type ExecutionGenerationState,
} from '../inventory-generation.js';
import { canonicalJson, compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import {
  ToolContractsFileSchema,
  ToolTombstonesFileSchema,
  toToolContract,
  type ToolContractsFile,
} from './files.js';
import type { ToolContract } from './types.js';

type Execution = FoundationExecutionInventory['executions'][number];
type Tombstone = ExecutionGenerationState['tombstones'][number];

export class ToolStateError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ToolStateError';
    this.path = path;
  }
}

export interface PreviousArtifactView {
  /** Present only when the committed artifact is not conflicted. */
  artifact?: AppSetupArtifact;
  planner?: AppSetupArtifact['planner'];
  /** Strictest previous risk per tool across all merge sides. */
  riskByToolId: ReadonlyMap<string, ToolRiskClass>;
}

export interface PreviousToolState {
  state?: ExecutionGenerationState;
  artifact?: PreviousArtifactView;
  contracts: ReadonlyMap<string, ToolContract>;
  receiptMode?: 'standalone' | 'managed';
}

/** Splits a file with git merge markers into its two sides (diff3 base dropped). */
export function splitMergeConflict(text: string): [string, string] | undefined {
  if (!/^<{7} /m.test(text)) return undefined;
  const ours: string[] = [];
  const theirs: string[] = [];
  let section: 'both' | 'ours' | 'base' | 'theirs' = 'both';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('<<<<<<< ')) { section = 'ours'; continue; }
    if (line.startsWith('||||||| ') && section === 'ours') { section = 'base'; continue; }
    if (line === '=======' && (section === 'ours' || section === 'base')) { section = 'theirs'; continue; }
    if (line.startsWith('>>>>>>> ') && section === 'theirs') { section = 'both'; continue; }
    if (section === 'both' || section === 'ours') ours.push(rawLine);
    if (section === 'both' || section === 'theirs') theirs.push(rawLine);
  }
  return [ours.join('\n'), theirs.join('\n')];
}

/**
 * A committed state file that is absent means "no previous state". A path the
 * caller named explicitly (`required`, e.g. `--adopt`) must exist: a typo there
 * would otherwise silently discard the committed identities it should adopt.
 */
async function readSides(
  root: string,
  path: string,
  options: { required?: boolean } = {},
): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(resolve(root, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.required) throw new ToolStateError(path, `${path} does not exist.`);
      return [];
    }
    throw error;
  }
  const sides = splitMergeConflict(text) ?? [text];
  try {
    return sides.map((side) => JSON.parse(side) as unknown);
  } catch {
    throw new ToolStateError(path, `${path} is not valid JSON.`);
  }
}

function parseSides<T>(path: string, sides: ReadonlyArray<unknown>, schema: z.ZodType<T>): T[] {
  return sides.map((side) => {
    const parsed = schema.safeParse(side);
    if (!parsed.success) throw new ToolStateError(path, `${path} does not match its schema.`);
    return parsed.data;
  });
}

function byToolId(left: { toolId: string }, right: { toolId: string }): number {
  return compareCodeUnits(left.toolId, right.toolId);
}

function preferExecution(
  left: Execution,
  right: Execution,
  tombstones: ReadonlyMap<string, Tombstone>,
): Execution {
  const leftDead = tombstones.has(left.toolId);
  const rightDead = tombstones.has(right.toolId);
  if (leftDead !== rightDead) return leftDead ? right : left;
  if (left.toolId !== right.toolId) {
    return compareCodeUnits(left.toolId, right.toolId) <= 0 ? left : right;
  }
  return compareCodeUnits(canonicalJson(left), canonicalJson(right)) <= 0 ? left : right;
}

/**
 * Deterministic union of all inventory and tombstone sides. A tombstoned
 * identity never becomes live again; a losing identity for the same key is
 * tombstoned so it cannot come back either.
 */
export function mergeGenerationState(
  config: Pick<ToolsConfig, 'appId' | 'targetAppKey'>,
  inventories: ReadonlyArray<FoundationExecutionInventory>,
  tombstoneList: ReadonlyArray<Tombstone>,
): ExecutionGenerationState | undefined {
  if (inventories.length === 0 && tombstoneList.length === 0) return undefined;
  const tombstones = new Map<string, Tombstone>();
  for (const tombstone of [...tombstoneList].sort(byToolId)) {
    if (!tombstones.has(tombstone.toolId)) tombstones.set(tombstone.toolId, tombstone);
  }
  const chosen = new Map<string, Execution>();
  for (const execution of inventories.flatMap((inventory) => inventory.executions)) {
    const current = chosen.get(execution.stableKey);
    if (!current) {
      chosen.set(execution.stableKey, execution);
      continue;
    }
    const winner = preferExecution(current, execution, tombstones);
    const loser = winner === current ? execution : current;
    chosen.set(execution.stableKey, winner);
    if (loser.toolId !== winner.toolId && !tombstones.has(loser.toolId)) {
      tombstones.set(loser.toolId, {
        toolId: loser.toolId,
        stableKey: loser.stableKey,
        definitionId: loser.definitionId,
      });
    }
  }
  for (const [stableKey, execution] of [...chosen]) {
    if (tombstones.has(execution.toolId)) chosen.delete(stableKey);
  }
  // Two branches may each have derived the same name for different routes.
  // Dropping the later key re-derives its name; its UUIDv5 identity is
  // recomputed from app, key and tombstone generation by reconcile.
  const definitionIds = new Set<string>();
  for (const execution of [...chosen.values()].sort((left, right) => (
    compareCodeUnits(left.stableKey, right.stableKey)
  ))) {
    if (definitionIds.has(execution.definitionId)) {
      chosen.delete(execution.stableKey);
      continue;
    }
    definitionIds.add(execution.definitionId);
  }
  return ExecutionGenerationStateSchema.parse({
    schemaVersion: 1,
    appId: config.appId,
    inventory: {
      schemaVersion: 2,
      targetAppKey: config.targetAppKey,
      executions: [...chosen.values()].sort(byToolId),
    },
    tombstones: [...tombstones.values()].sort(byToolId),
  });
}

function artifactView(artifacts: ReadonlyArray<AppSetupArtifact>): PreviousArtifactView {
  const riskByToolId = new Map<string, ToolRiskClass>();
  for (const tool of artifacts.flatMap((artifact) => artifact.tools)) {
    const current = riskByToolId.get(tool.toolId);
    if (!current || riskTier(tool.riskClass) > riskTier(current)) {
      riskByToolId.set(tool.toolId, tool.riskClass);
    }
  }
  return {
    ...(artifacts.length === 1 ? { artifact: artifacts[0] } : {}),
    planner: artifacts[0]!.planner,
    riskByToolId,
  };
}

function isStaleBound(contract: ToolContract): boolean {
  return contract.binding !== undefined
    && contract.binding.interfaceDigest !== contract.interfaceDigest;
}

function mergeContracts(
  entries: ReadonlyArray<ToolContractsFile['tools'][number]>,
): Map<string, ToolContract> {
  const contracts = new Map<string, ToolContract>();
  for (const entry of entries) {
    if (!entry.contract) continue;
    const next = toToolContract(entry.contract);
    const current = contracts.get(entry.stableKey);
    if (!current) {
      contracts.set(entry.stableKey, next);
      continue;
    }
    if (isStaleBound(current) !== isStaleBound(next)) {
      if (isStaleBound(next)) contracts.set(entry.stableKey, next);
      continue;
    }
    if (compareCodeUnits(canonicalJson(next), canonicalJson(current)) < 0) {
      contracts.set(entry.stableKey, next);
    }
  }
  return contracts;
}

/** Only the mode is read; a conflicted receipt keeps `managed` if either side was managed. */
async function readReceiptMode(root: string): Promise<'standalone' | 'managed' | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(root, TOOLS_PATHS.receipt), 'utf8');
  } catch {
    return undefined;
  }
  let mode: 'standalone' | 'managed' | undefined;
  for (const side of splitMergeConflict(text) ?? [text]) {
    try {
      const parsed = JSON.parse(side) as { mode?: unknown };
      if (parsed.mode === 'managed') return 'managed';
      if (parsed.mode === 'standalone') mode = 'standalone';
    } catch {
      // An unreadable side carries no mode.
    }
  }
  return mode;
}

export async function readPreviousToolState(
  root: string,
  config: ToolsConfig,
  options: { adoptInventoryPath?: string } = {},
): Promise<PreviousToolState> {
  const inventoryPath = options.adoptInventoryPath ?? TOOLS_PATHS.inventory;
  const inventories = parseSides(
    inventoryPath,
    await readSides(root, inventoryPath, { required: options.adoptInventoryPath !== undefined }),
    FoundationExecutionInventorySchema,
  );
  for (const inventory of inventories) {
    if (inventory.targetAppKey !== config.targetAppKey) {
      throw new ToolStateError(inventoryPath, `${inventoryPath} belongs to target app key ${inventory.targetAppKey}.`);
    }
  }
  const tombstoneFiles = parseSides(
    TOOLS_PATHS.tombstones,
    await readSides(root, TOOLS_PATHS.tombstones),
    ToolTombstonesFileSchema,
  );
  for (const file of tombstoneFiles) {
    if (file.appId !== config.appId) {
      throw new ToolStateError(TOOLS_PATHS.tombstones, `${TOOLS_PATHS.tombstones} belongs to a different app.`);
    }
  }
  const state = mergeGenerationState(
    config,
    inventories,
    tombstoneFiles.flatMap((file) => file.tombstones),
  );
  const artifacts = parseSides(
    TOOLS_PATHS.setupArtifact,
    await readSides(root, TOOLS_PATHS.setupArtifact),
    AppSetupArtifactSchema,
  ).filter((artifact) => artifact.appId === config.appId);
  const contractFiles = parseSides(
    TOOLS_PATHS.contracts,
    await readSides(root, TOOLS_PATHS.contracts),
    ToolContractsFileSchema,
  ).filter((file) => file.appId === config.appId);
  const receiptMode = await readReceiptMode(root);
  return {
    ...(state ? { state } : {}),
    ...(artifacts.length ? { artifact: artifactView(artifacts) } : {}),
    contracts: mergeContracts(contractFiles.flatMap((file) => file.tools)),
    ...(receiptMode ? { receiptMode } : {}),
  };
}

export function renderInventory(state: ExecutionGenerationState): string {
  return canonicalJson(state.inventory);
}

export function renderTombstones(state: ExecutionGenerationState): string {
  return canonicalJson({ schemaVersion: 1, appId: state.appId, tombstones: state.tombstones });
}
