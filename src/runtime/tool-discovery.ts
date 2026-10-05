import type { ToolPresentation } from '../contracts/index.js';
import { riskTier } from '../contracts/tool-policy.js';
import type { ToolRegistry } from '../types.js';
import { authorizeToolCall } from './authorization.js';
import { modelFacingToolName } from './local-tool-bindings.js';
import { createToolSearchIndex } from './tool-search.js';
import type { TurnSnapshot } from './turn-snapshot.js';

export interface ToolDiscoveryResult {
  readonly name: string;
  readonly description: string;
  readonly module?: string;
  readonly usageHints?: ReadonlyArray<string>;
  readonly presentation?: Readonly<ToolPresentation>;
}

export interface TurnToolDiscovery {
  readonly turnId: string;
  readonly eligibleNames: ReadonlyArray<string>;
  search(query: string, limit?: number): ReadonlyArray<ToolDiscoveryResult>;
}

export interface TurnToolDiscoveryOptions {
  maxQueryLength?: number;
  maxResults?: number;
  maxDescriptionLength?: number;
  maxHintLength?: number;
}

/**
 * Search-only enrichment keyed by the model-facing tool name. Synonyms are
 * indexed but never returned and never make a tool eligible.
 */
export interface ToolSearchSemantics {
  readonly synonyms?: ReadonlyArray<string>;
}

export type ToolSearchSemanticsMap = Readonly<Record<string, ToolSearchSemantics>>;

interface DiscoveryEntry {
  result: ToolDiscoveryResult;
  synonyms: ReadonlyArray<string>;
  sharedWith: ReadonlyArray<string>;
}

const DEFAULT_MAX_QUERY_LENGTH = 200;
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 20;
const DEFAULT_MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_MAX_HINT_LENGTH = 300;
const MAX_SYNONYMS = 20;
const MAX_SYNONYM_LENGTH = 100;

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function freezeResult(result: ToolDiscoveryResult): ToolDiscoveryResult {
  if (result.usageHints) Object.freeze(result.usageHints);
  if (result.presentation) Object.freeze(result.presentation);
  return Object.freeze(result);
}

function boundedSynonyms(
  semantics: ToolSearchSemanticsMap | undefined,
  name: string,
): ReadonlyArray<string> {
  const entry = semantics && Object.hasOwn(semantics, name)
    ? semantics[name]
    : undefined;
  return (entry?.synonyms ?? [])
    .filter((synonym): synonym is string => typeof synonym === 'string')
    .slice(0, MAX_SYNONYMS)
    .map((synonym) => bounded(synonym, MAX_SYNONYM_LENGTH));
}

function resolveLimits(options: TurnToolDiscoveryOptions) {
  return {
    maxQueryLength: Math.min(
      Math.max(options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH, 1),
      DEFAULT_MAX_QUERY_LENGTH,
    ),
    maxResults: Math.min(
      Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
      HARD_MAX_RESULTS,
    ),
    maxDescriptionLength: Math.min(
      Math.max(options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH, 1),
      DEFAULT_MAX_DESCRIPTION_LENGTH,
    ),
    maxHintLength: Math.min(
      Math.max(options.maxHintLength ?? DEFAULT_MAX_HINT_LENGTH, 1),
      DEFAULT_MAX_HINT_LENGTH,
    ),
  };
}

function createDiscovery(
  turnId: string,
  unsortedEntries: DiscoveryEntry[],
  limits: ReturnType<typeof resolveLimits>,
): TurnToolDiscovery {
  const entries = [...unsortedEntries].sort((left, right) =>
    left.result.name.localeCompare(right.result.name));
  Object.freeze(entries);
  const byName = new Map(entries.map((entry) => [entry.result.name, entry.result] as const));
  const eligibleNames = Object.freeze(entries.map((entry) => entry.result.name));
  const index = createToolSearchIndex(entries.map((entry) => ({
    name: entry.result.name,
    description: entry.result.description,
    ...(entry.result.module ? { module: entry.result.module } : {}),
    sharedWith: entry.sharedWith,
    ...(entry.result.usageHints ? { usageHints: entry.result.usageHints } : {}),
    synonyms: entry.synonyms,
  })));

  return Object.freeze({
    turnId,
    eligibleNames,
    search(query: string, limit = limits.maxResults) {
      if (query.length > limits.maxQueryLength) {
        throw new Error('Tool discovery query exceeds the configured limit.');
      }
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), limits.maxResults);
      return Object.freeze(index.search(query, boundedLimit)
        .map((name) => byName.get(name))
        .filter((result): result is ToolDiscoveryResult => result !== undefined));
    },
  });
}

/**
 * Builds a content-bounded search index from the immutable turn snapshot and
 * the already materialized local registry. Discovery neither grants access
 * nor holds an executor or schema reference.
 */
export function createTurnToolDiscovery(
  input: {
    snapshot: TurnSnapshot;
    registry: ToolRegistry;
    revokedToolIds?: ReadonlyArray<string>;
    semantics?: ToolSearchSemanticsMap;
  },
  options: TurnToolDiscoveryOptions = {},
): TurnToolDiscovery {
  const limits = resolveLimits(options);
  const { maxDescriptionLength, maxHintLength } = limits;
  const revoked = new Set(input.revokedToolIds ?? []);
  const policies = new Map(input.snapshot.policyRevision.toolPolicies.map(
    (policy) => [policy.toolId, policy] as const,
  ));
  const entries: DiscoveryEntry[] = [];

  for (const manifestTool of input.snapshot.manifestRevision.tools) {
    const name = modelFacingToolName(manifestTool.name);
    const binding = input.registry[name];
    const policy = policies.get(manifestTool.toolId);
    const authorization = authorizeToolCall({
      principal: input.snapshot.principal,
      agentRevision: input.snapshot.agentRevision,
      manifestRevision: input.snapshot.manifestRevision,
      policyRevision: input.snapshot.policyRevision,
      toolId: manifestTool.toolId,
    });
    if (
      revoked.has(manifestTool.toolId)
      || !binding
      || binding.id !== manifestTool.toolId
      || !policy
      || riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)
      || !authorization.allowed
    ) {
      continue;
    }
    const description = bounded(manifestTool.description, maxDescriptionLength);
    const usageHints = manifestTool.usageHints?.map((hint) =>
      bounded(hint, maxHintLength));
    const result = freezeResult({
      name,
      description,
      ...(manifestTool.module ? { module: manifestTool.module } : {}),
      ...(usageHints ? { usageHints } : {}),
      ...(manifestTool.presentation
        ? { presentation: { ...manifestTool.presentation } }
        : {}),
    });
    entries.push({
      result,
      synonyms: boundedSynonyms(input.semantics, name),
      sharedWith: manifestTool.sharedWith ?? [],
    });
  }
  return createDiscovery(input.snapshot.turnId, entries, limits);
}

/**
 * Discovery for apps without a managed or standalone runtime source. The
 * per-request registry is the deployed, app-authorized tool set; names in
 * `excludeNames` (SDK built-ins) are never indexed.
 */
export function createRegistryToolDiscovery(
  input: {
    turnId: string;
    registry: ToolRegistry;
    excludeNames?: ReadonlyArray<string>;
    semantics?: ToolSearchSemanticsMap;
  },
  options: TurnToolDiscoveryOptions = {},
): TurnToolDiscovery {
  const limits = resolveLimits(options);
  const excluded = new Set(input.excludeNames ?? []);
  const entries: DiscoveryEntry[] = [];
  for (const [name, tool] of Object.entries(input.registry)) {
    if (excluded.has(name) || typeof tool?.description !== 'string') continue;
    entries.push({
      result: freezeResult({
        name,
        description: bounded(tool.description, limits.maxDescriptionLength),
      }),
      synonyms: boundedSynonyms(input.semantics, name),
      sharedWith: [],
    });
  }
  return createDiscovery(input.turnId, entries, limits);
}
