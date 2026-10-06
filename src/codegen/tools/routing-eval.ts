import type { AppSetupArtifact } from '../../contracts/index.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import { createToolSearchIndex } from '../../runtime/tool-search.js';
import { compareCodeUnits } from './canonical.js';
import type { ToolContractsEntry } from './types.js';

/** A sentence passes when its tool is among this many `find_tools` hits. */
export const DEFAULT_ROUTING_TOP = 3;

export interface RoutingSentenceFailure {
  sentence: string;
  /** 1-based rank of the expected tool, or null when the search does not return it. */
  rank: number | null;
  /** The tools that `find_tools` ranks above it (by name), at most `top`. */
  competitors: string[];
  /** The first hit belongs to another module, so module routing would go astray. */
  moduleMismatch: boolean;
}

export interface RoutingToolResult {
  tool: string;
  stableKey: string;
  module: string;
  sentences: number;
  failures: RoutingSentenceFailure[];
}

export interface RoutingEvaluation {
  schemaVersion: 1;
  top: number;
  summary: {
    /** Enabled tools the chat can find. */
    tools: number;
    /** Tools with example sentences. */
    evaluated: number;
    sentences: number;
    passed: number;
    failed: number;
    /** Enabled tools without example sentences, by name. */
    withoutExamples: string[];
  };
  /** Evaluated tools, by name; `failures` lists each sentence that does not find its tool. */
  tools: RoutingToolResult[];
}

/**
 * Deterministic routing check (spec 4.7 "Qualitätsschleife"): every example
 * sentence of a tool must find that tool among the first `find_tools` hits,
 * built exactly like the runtime index (name, description, module, shared
 * modules, usage hints, synonyms), and the first hit must lie in the tool's
 * module. No model, no network, no clock: the same outputs give the same
 * bytes, so CI can run it as the FR-3 regression corpus.
 */
export function evaluateRouting(input: {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<Pick<ToolContractsEntry, 'toolId' | 'stableKey' | 'search'>>;
  top?: number;
}): RoutingEvaluation {
  const top = Math.max(1, Math.trunc(input.top ?? DEFAULT_ROUTING_TOP));
  const search = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools = input.artifact.tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({ tool, modelName: tool.modelName ?? modelFacingToolName(tool.name), entry: search.get(tool.toolId) }))
    .sort((left, right) => compareCodeUnits(left.tool.name, right.tool.name));
  const byModelName = new Map(tools.map((item) => [item.modelName, item] as const));
  const index = createToolSearchIndex(tools.map(({ tool, modelName, entry }) => ({
    name: modelName,
    description: tool.description ?? '',
    ...(tool.module ? { module: tool.module } : {}),
    sharedWith: tool.sharedWith ?? [],
    usageHints: tool.usageHints ?? [],
    synonyms: entry?.search?.synonyms ?? [],
  })));
  const results: RoutingToolResult[] = [];
  const withoutExamples: string[] = [];
  let sentences = 0;
  let failed = 0;
  for (const { tool, modelName, entry } of tools) {
    const examples = entry?.search?.examples ?? [];
    if (examples.length === 0) {
      withoutExamples.push(tool.name);
      continue;
    }
    const failures: RoutingSentenceFailure[] = [];
    for (const sentence of examples) {
      sentences += 1;
      const ranked = index.search(sentence, tools.length);
      const position = ranked.indexOf(modelName);
      const rank = position < 0 ? null : position + 1;
      const first = ranked[0] === undefined ? undefined : byModelName.get(ranked[0]);
      const moduleMismatch = first !== undefined && first.modelName !== modelName && first.tool.module !== tool.module;
      if (rank !== null && rank <= top && !moduleMismatch) continue;
      failed += 1;
      failures.push({
        sentence,
        rank,
        competitors: ranked.slice(0, rank === null ? top : Math.min(rank - 1, top))
          .map((name) => byModelName.get(name)?.tool.name ?? name),
        moduleMismatch,
      });
    }
    results.push({
      tool: tool.name,
      stableKey: entry?.stableKey ?? tool.name,
      module: tool.module ?? '',
      sentences: examples.length,
      failures,
    });
  }
  return {
    schemaVersion: 1,
    top,
    summary: {
      tools: tools.length,
      evaluated: results.length,
      sentences,
      passed: sentences - failed,
      failed,
      withoutExamples,
    },
    tools: results,
  };
}
