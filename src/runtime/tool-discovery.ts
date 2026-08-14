import type { ToolPresentation } from '../contracts/index.js';
import type { ToolRegistry } from '../types.js';
import { authorizeToolCall } from './authorization.js';
import { modelFacingToolName } from './local-tool-bindings.js';
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

interface DiscoveryEntry {
  result: ToolDiscoveryResult;
  nameTokens: ReadonlyArray<string>;
  descriptionTokens: ReadonlyArray<string>;
  moduleTokens: ReadonlyArray<string>;
  hintTokens: ReadonlyArray<string>;
  nameText: string;
  descriptionText: string;
  moduleText: string;
  hintText: string;
}

const DEFAULT_MAX_QUERY_LENGTH = 200;
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 20;
const DEFAULT_MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_MAX_HINT_LENGTH = 300;

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function freezeResult(result: ToolDiscoveryResult): ToolDiscoveryResult {
  if (result.usageHints) Object.freeze(result.usageHints);
  if (result.presentation) Object.freeze(result.presentation);
  return Object.freeze(result);
}

function rank(entry: DiscoveryEntry, query: string): number | undefined {
  const queryTokens = words(query);
  if (queryTokens.length === 0) return undefined;
  const allIn = (tokens: ReadonlyArray<string>) =>
    queryTokens.every((token) => tokens.includes(token));
  const textIncludes = (text: string) => text.includes(query.toLocaleLowerCase('en-US'));

  if (entry.nameText === query.toLocaleLowerCase('en-US')) return 0;
  if (allIn(entry.nameTokens)) return 1;
  if (textIncludes(entry.nameText)) return 2;
  if (allIn(entry.descriptionTokens)) return 3;
  if (textIncludes(entry.descriptionText)) return 4;
  if (allIn(entry.moduleTokens) || textIncludes(entry.moduleText)) return 5;
  if (allIn(entry.hintTokens) || textIncludes(entry.hintText)) return 6;
  return undefined;
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
  },
  options: TurnToolDiscoveryOptions = {},
): TurnToolDiscovery {
  const maxQueryLength = Math.min(
    Math.max(options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH, 1),
    DEFAULT_MAX_QUERY_LENGTH,
  );
  const maxResults = Math.min(
    Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
    HARD_MAX_RESULTS,
  );
  const maxDescriptionLength = Math.min(
    Math.max(options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH, 1),
    DEFAULT_MAX_DESCRIPTION_LENGTH,
  );
  const maxHintLength = Math.min(
    Math.max(options.maxHintLength ?? DEFAULT_MAX_HINT_LENGTH, 1),
    DEFAULT_MAX_HINT_LENGTH,
  );
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
      || policy.riskClass !== manifestTool.riskClass
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
    const moduleValues = [manifestTool.module, ...(manifestTool.sharedWith ?? [])]
      .filter((value): value is string => Boolean(value));
    entries.push({
      result,
      nameTokens: words(name),
      descriptionTokens: words(description),
      moduleTokens: words(moduleValues.join(' ')),
      hintTokens: words((usageHints ?? []).join(' ')),
      nameText: name.toLocaleLowerCase('en-US'),
      descriptionText: description.toLocaleLowerCase('en-US'),
      moduleText: moduleValues.join(' ').toLocaleLowerCase('en-US'),
      hintText: (usageHints ?? []).join(' ').toLocaleLowerCase('en-US'),
    });
  }
  entries.sort((left, right) => left.result.name.localeCompare(right.result.name));
  Object.freeze(entries);
  const eligibleNames = Object.freeze(entries.map((entry) => entry.result.name));

  return Object.freeze({
    turnId: input.snapshot.turnId,
    eligibleNames,
    search(query: string, limit = maxResults) {
      if (query.length > maxQueryLength) {
        throw new Error('Tool discovery query exceeds the configured limit.');
      }
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), maxResults);
      const ranked = entries
        .map((entry) => ({ entry, rank: rank(entry, query) }))
        .filter((candidate): candidate is { entry: DiscoveryEntry; rank: number } =>
          candidate.rank !== undefined)
        .sort((left, right) =>
          left.rank - right.rank
          || left.entry.result.name.localeCompare(right.entry.result.name))
        .slice(0, boundedLimit)
        .map((candidate) => candidate.entry.result);
      return Object.freeze(ranked);
    },
  });
}
