import { newStemmer } from 'snowball-stemmers';
import type { ModuleDefinition, ToolRegistry } from '../../../types.js';
import { rankModulesWithHeuristics } from '../../core/intent-classifier.js';
import { createToolSearchIndex } from '../../../runtime/tool-search.js';
import type { ToolSearchSemanticsMap } from '../../../runtime/index.js';

/** Content-bounded tool facts the default router groups and ranks. */
export interface RoutableTool {
  /** Model-facing tool name (registry key). */
  readonly name: string;
  readonly description: string;
  readonly module?: string;
  readonly sharedWith?: ReadonlyArray<string>;
  readonly usageHints?: ReadonlyArray<string>;
  readonly synonyms?: ReadonlyArray<string>;
  readonly examples?: ReadonlyArray<string>;
  readonly kind?: 'endpoint' | 'ui';
  readonly method?: string;
}

export interface DefaultIntentRoutingOptions {
  /** Upper bound of domain tools in the start set, without the always-available ones. Default 10. */
  maxStartTools?: number;
  /** Model-facing tool names that start every turn. Default: `ui_navigate` when present. */
  alwaysAvailable?: ReadonlyArray<string>;
}

export interface PreviousTurnScope {
  /** Domain tools the last assistant turn called, oldest first. */
  toolNames: string[];
  /** Earlier user texts, oldest first (the newest is the request before this one). */
  userTexts: string[];
}

export interface DefaultRoutingDecision {
  toolNames: string[];
  /** Module groups the classifier matched for this turn. */
  modules: string[];
  confidence: 'matched' | 'previous-turn' | 'low';
}

export interface DefaultIntentRouter {
  route(input: { text: string; previous?: PreviousTurnScope }): DefaultRoutingDecision;
}

const DEFAULT_MAX_START_TOOLS = 10;
const MAX_SEARCH_HITS = 6;
const MAX_CARRIED_TOOLS = 4;
const MODULE_MIN_SCORE = 0.15;
const SECOND_MODULE_RATIO = 0.75;
const DEFAULT_ALWAYS_AVAILABLE = ['ui_navigate'];
const SDK_TOOL_NAMES = new Set([
  'find_tools', 'suggest_followups', 'ask_clarification', 'update_plan',
]);
const READ_METHODS = new Set(['GET', 'HEAD']);

const englishStemmer = newStemmer('english');

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter(Boolean);
}

function root(word: string): string {
  return englishStemmer.stem(word);
}

function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim().slice(0, 200);
}

/**
 * Groups tools by the leading word of their module, so fragments such as
 * `tasksReminder` join `tasks`. UI tools of a generic `ui` module join the
 * domain their name mentions (`ui.filter.tasksKanban` → tasks).
 */
function groupTools(tools: ReadonlyArray<RoutableTool>): Map<string, RoutableTool[]> {
  const keyOf = new Map<string, string>();
  const domainKeys = new Set<string>();
  for (const tool of tools) {
    const moduleWords = words(tool.module ?? '');
    if (moduleWords.length === 0 || moduleWords[0] === 'ui') continue;
    const key = root(moduleWords[0]!);
    keyOf.set(tool.name, key);
    domainKeys.add(key);
  }
  for (const tool of tools) {
    if (keyOf.has(tool.name)) continue;
    const nameWords = words(tool.name).filter((word) => word !== 'ui');
    const domain = nameWords.map(root).find((word) => domainKeys.has(word));
    keyOf.set(tool.name, domain ?? 'ui');
  }
  const groups = new Map<string, RoutableTool[]>();
  for (const tool of tools) {
    const key = keyOf.get(tool.name)!;
    groups.set(key, [...groups.get(key) ?? [], tool]);
  }
  return groups;
}

function moduleDefinition(key: string, members: RoutableTool[]): ModuleDefinition {
  const moduleNames = [...new Set(members.map((tool) => tool.module).filter(Boolean))];
  const examples = members.flatMap((tool) => [
    words(tool.name).join(' '),
    firstSentence(tool.description),
    ...tool.usageHints ?? [],
    ...tool.synonyms ?? [],
    ...tool.examples ?? [],
  ]).filter((example) => example.length > 0);
  return {
    id: key,
    name: key,
    description: moduleNames.map((name) => words(name!).join(' ')).join(', ') || key,
    tools: members.map((tool) => tool.name),
    classification: { hint: key, examples: [...new Set(examples)] },
  };
}

/**
 * Built-in router of `createAiChatHandler`: derives modules from generated
 * tool metadata, classifies the request with the local heuristics (German
 * and English) and returns a small start set. Discovery widens it on demand.
 */
export function createDefaultIntentRouter(
  tools: ReadonlyArray<RoutableTool>,
  options: DefaultIntentRoutingOptions = {},
): DefaultIntentRouter {
  const maxStartTools = Math.max(1, options.maxStartTools ?? DEFAULT_MAX_START_TOOLS);
  const domainTools = tools.filter((tool) => !SDK_TOOL_NAMES.has(tool.name));
  const byName = new Map(domainTools.map((tool) => [tool.name, tool] as const));
  const alwaysAvailable = (options.alwaysAvailable ?? DEFAULT_ALWAYS_AVAILABLE)
    .filter((name) => byName.has(name));
  const groups = groupTools(domainTools);
  const modules = [...groups].map(([key, members]) => moduleDefinition(key, members));
  const index = createToolSearchIndex(domainTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.module ? { module: tool.module } : {}),
    ...(tool.sharedWith ? { sharedWith: tool.sharedWith } : {}),
    usageHints: [...tool.usageHints ?? [], ...tool.examples ?? []],
    ...(tool.synonyms ? { synonyms: tool.synonyms } : {}),
  })));

  const match = (text: string) => {
    const hits = text.trim() ? [...index.search(text.slice(0, 200), MAX_SEARCH_HITS)] : [];
    const best = new Map<string, number>();
    for (const locale of ['de', 'en']) {
      for (const { moduleId, score } of rankModulesWithHeuristics(text, modules, locale)) {
        best.set(moduleId, Math.max(best.get(moduleId) ?? 0, score));
      }
    }
    const ranked = [...best].sort((left, right) => right[1] - left[1]);
    const top = ranked[0]?.[1] ?? 0;
    const matchedModules = ranked
      .slice(0, 2)
      .filter(([, score], position) =>
        score >= MODULE_MIN_SCORE && (position === 0 || score >= top * SECOND_MODULE_RATIO))
      .map(([key]) => key);
    return { hits, modules: matchedModules };
  };

  const moduleTools = (keys: ReadonlyArray<string>, text: string): string[] => {
    const relevance = new Map(index.search(text.slice(0, 200), domainTools.length)
      .map((name, position) => [name, position] as const));
    return keys.flatMap((key) => [...groups.get(key) ?? []]
      .sort((left, right) =>
        (relevance.get(left.name) ?? Infinity) - (relevance.get(right.name) ?? Infinity)
        || Number(!isRead(left)) - Number(!isRead(right))
        || left.name.localeCompare(right.name))
      .map((tool) => tool.name));
  };

  const router: DefaultIntentRouter = {
    route({ text, previous }) {
      const carried = (previous?.toolNames ?? [])
        .filter((name) => byName.has(name))
        .slice(-MAX_CARRIED_TOOLS);
      const current = match(text);
      const weak = current.hits.length === 0 && current.modules.length === 0;
      const previousText = previous?.userTexts.at(-1);
      const earlier = weak && previousText ? match(previousText) : undefined;

      const ordered = [
        ...carried,
        ...current.hits,
        ...earlier?.hits ?? [],
        ...moduleTools(current.modules, text),
        ...earlier ? moduleTools(earlier.modules, previousText!) : [],
      ];
      const selected = [...new Set(ordered)]
        .filter((name) => !alwaysAvailable.includes(name))
        .slice(0, maxStartTools);
      return {
        toolNames: [...new Set([...selected, ...alwaysAvailable])],
        modules: [...new Set([...current.modules, ...earlier?.modules ?? []])],
        confidence: !weak
          ? 'matched'
          : carried.length > 0 || (earlier && (earlier.hits.length > 0 || earlier.modules.length > 0))
            ? 'previous-turn'
            : 'low',
      };
    },
  };
  return Object.freeze(router);
}

function isRead(tool: RoutableTool): boolean {
  return tool.kind === 'ui' || READ_METHODS.has((tool.method ?? '').toUpperCase());
}

function synonymsOf(semantics: ToolSearchSemanticsMap | undefined, name: string) {
  const entry = semantics && Object.hasOwn(semantics, name) ? semantics[name] : undefined;
  return {
    ...(entry?.synonyms?.length ? { synonyms: entry.synonyms } : {}),
    ...(entry?.examples?.length ? { examples: entry.examples } : {}),
  };
}

/** Routable facts of pinned manifest tools (`name` is the manifest name, e.g. `tasks.list`). */
export function routableToolsFromManifest(
  manifestTools: ReadonlyArray<{
    name: string;
    description: string;
    module?: string;
    sharedWith?: ReadonlyArray<string>;
    usageHints?: ReadonlyArray<string>;
    executionKind?: 'endpoint' | 'ui';
    method?: string;
  }>,
  semantics?: ToolSearchSemanticsMap,
): RoutableTool[] {
  return manifestTools.map((tool) => {
    const name = tool.name.replace(/\./g, '_');
    return {
      name,
      description: tool.description,
      ...(tool.module ? { module: tool.module } : {}),
      ...(tool.sharedWith ? { sharedWith: tool.sharedWith } : {}),
      ...(tool.usageHints ? { usageHints: tool.usageHints } : {}),
      ...(tool.executionKind ? { kind: tool.executionKind } : {}),
      ...(tool.method ? { method: tool.method } : {}),
      ...synonymsOf(semantics, name),
    };
  });
}

/** Routable facts of a plain registry; the module is the leading segment of the tool id. */
export function routableToolsFromRegistry(
  registry: ToolRegistry,
  semantics?: ToolSearchSemanticsMap,
): RoutableTool[] {
  return Object.entries(registry)
    .filter(([name, tool]) => !SDK_TOOL_NAMES.has(name) && typeof tool?.description === 'string')
    .map(([name, tool]) => {
      const idModule = typeof tool.id === 'string' && tool.id.includes('.')
        ? tool.id.split('.')[0]
        : undefined;
      return {
        name,
        description: tool.description,
        module: idModule ?? name.split(/[_.]/)[0],
        ...(tool.method ? { method: tool.method } : {}),
        ...synonymsOf(semantics, name),
      };
    });
}

/**
 * Scope of the previous turn from the UI history: tools the last assistant
 * message called, and the user texts before the current request.
 */
export function previousTurnScope(messages: ReadonlyArray<unknown>): PreviousTurnScope {
  const list = messages as ReadonlyArray<{ role?: unknown; parts?: unknown }>;
  let current = list.length - 1;
  while (current >= 0 && list[current]?.role !== 'user') current--;
  const toolNames: string[] = [];
  const userTexts: string[] = [];
  let assistantSeen = false;
  for (let i = current - 1; i >= 0; i--) {
    const message = list[i];
    const parts = Array.isArray(message?.parts) ? message.parts as Array<Record<string, unknown>> : [];
    if (message?.role === 'assistant' && !assistantSeen) {
      assistantSeen = true;
      for (const part of parts) {
        const name = typeof part.type === 'string' && part.type.startsWith('tool-')
          ? part.type.slice(5)
          : part.type === 'dynamic-tool' && typeof part.toolName === 'string'
            ? part.toolName
            : undefined;
        if (name && !SDK_TOOL_NAMES.has(name) && !toolNames.includes(name)) toolNames.push(name);
      }
    } else if (message?.role === 'user') {
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join(' ')
        .trim();
      if (text) userTexts.unshift(text);
      if (userTexts.length >= 2) break;
    }
  }
  return { toolNames, userTexts };
}

const ROUTER_CACHE_SIZE = 16;
const NO_SEMANTICS = {};
const routerCaches = new WeakMap<object, Map<string, DefaultIntentRouter>>();

/**
 * The default router for one turn's registry. Manifest metadata (module,
 * kind, hints) is used when the turn is pinned to a snapshot. Routers are
 * cached per semantics object, tool set, revision and options.
 */
export function defaultIntentRouterFor(input: {
  registry: ToolRegistry;
  manifest?: {
    revisionId: string;
    tools: Parameters<typeof routableToolsFromManifest>[0];
  };
  semantics?: ToolSearchSemanticsMap;
  options?: DefaultIntentRoutingOptions;
}): DefaultIntentRouter {
  const names = Object.keys(input.registry).sort();
  const identity = input.manifest
    ? [input.manifest.revisionId, names]
    : names.map((name) => [name, input.registry[name]?.id, input.registry[name]?.description]);
  const key = JSON.stringify([identity, input.options ?? null]);
  const cacheOwner = input.semantics ?? NO_SEMANTICS;
  let cache = routerCaches.get(cacheOwner);
  if (!cache) {
    cache = new Map();
    routerCaches.set(cacheOwner, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;
  const available = new Set(names);
  const tools = input.manifest
    ? routableToolsFromManifest(input.manifest.tools, input.semantics)
      .filter((tool) => available.has(tool.name))
    : routableToolsFromRegistry(input.registry, input.semantics);
  const router = createDefaultIntentRouter(tools, input.options);
  cache.set(key, router);
  if (cache.size > ROUTER_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return router;
}
