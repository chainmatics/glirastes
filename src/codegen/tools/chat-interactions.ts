import {
  CHAT_ENTITY_TYPE_PATTERN,
  CHAT_INTERACTION_LIMITS,
  parseChatInteractions,
  type ChatCommandData,
  type ChatEntityActionData,
  type ChatEntityData,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatText,
} from '../../contracts/chat-interactions.js';
import { entityIdFields, type OutputEntityDeclaration } from '../../contracts/entity-declaration.js';
import { idParameterStem, isBareIdParameter, NAME_KEYS, searchIdFieldCandidates } from '../../contracts/entity-identity.js';
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits } from './canonical.js';
import { actionLabel, commandLabel, humanizeIdentifier, singular, titleIn, type Label } from './chat-labels.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import {
  collectionOf,
  declarationItemsPath,
  resolveMentionSources,
  sameItemsPath,
  SEARCH_DESCRIPTION_FIELDS,
  SEARCH_LIMIT_PARAMS,
  type ChatMentionsConfig,
  type MentionTool,
} from './mention-sources.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry, ToolFinding, ToolTitle } from './types.js';

export { humanizeIdentifier } from './chat-labels.js';
export type { ChatMentionsConfig } from './mention-sources.js';

export interface DeriveChatInteractionsInput {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
  /** `.glirastes/tools.json` `mentions`; without it every recognised search endpoint is offered, as before. */
  mentions?: ChatMentionsConfig;
}

type ToolLabels = NonNullable<ToolContractsEntry['labels']>;

interface BoundTool {
  definitionId: string;
  method?: string;
  path?: string;
  contract: ToolContract;
  title?: ToolTitle;
  riskClass: string;
  noun?: { language: 'de' | 'en'; text: string };
  /** Labels per language of the tool contract (tools.json `languages`). */
  labels?: ToolLabels;
  outputEntities?: ReadonlyArray<OutputEntityDeclaration>;
}

/** Client actions of the chat itself; offering them inside the chat is noise. An override adds one back. */
export const CHAT_INTERNAL_ACTION = /^(?:ai-?chat|chat|assistant|command-?palette|command-?menu|cmdk)(?:[.\-_]|$)/i;

/** Query parameters that make a read endpoint an entity search, best first. */
const SEARCH_PARAMS = ['search', 'q', 'query', 'term'];
const LABEL_FIELDS: ReadonlyArray<string> = NAME_KEYS.search;
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const CONTROL = /[\u0000-\u001F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number = CHAT_INTERACTION_LIMITS.labelLength): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A text the list can show, clamped; `undefined` falls back to the derived label instead of dropping the entry. */
function safe(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && !CONTROL.test(trimmed) ? clamp(trimmed) : undefined;
}

function safeTitle(title: ToolTitle | undefined): ToolTitle | undefined {
  const kept = Object.entries(title ?? {})
    .map(([language, text]) => [language, safe(text)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The title's languages besides English and German, for a label derived in those two. */
function otherTitleLanguages(title: ToolTitle | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(title ?? {})
    .filter((entry): entry is [string, string] => entry[0] !== 'en' && entry[0] !== 'de' && typeof entry[1] === 'string'));
}

function clampLabel(label: Label): Label {
  return Object.fromEntries(Object.entries(label).map(([language, text]) => [language, clamp(text)])) as Label;
}

function nounOf(entity: ChatEntityData, language: string): string | undefined {
  return typeof entity.label === 'string' ? entity.label : entity.label[language];
}

/** A reviewed label names the thing; the templated fallback (and a title as label) repeats one text in all three. */
function isReviewed(labels: ToolLabels[string]): boolean {
  return !(labels.singular === labels.plural && labels.plural === labels.approval);
}

/**
 * The entity's label in every language the search tool has a reviewed
 * label for (its `labels` per language), else in English and German from
 * the presentation noun or the type. A language whose labels are the
 * English ones is the English fallback, not a label of its own.
 */
function entityLabel(tool: BoundTool, type: string): Record<string, string> {
  const fallback = clamp(humanizeIdentifier(type));
  const labels = tool.labels ?? {};
  const english = labels.en;
  const own: Record<string, string> = {};
  for (const [language, entry] of Object.entries(labels)) {
    if (!isReviewed(entry)) continue;
    if (language !== 'en' && english && entry.singular === english.singular
      && entry.plural === english.plural && entry.approval === english.approval) continue;
    const text = safe(entry.singular);
    if (text) own[language] = text;
  }
  const noun = tool.noun;
  return {
    ...own,
    en: own.en ?? (noun?.language === 'en' ? noun.text : fallback),
    de: own.de ?? (noun?.language === 'de' ? noun.text : fallback),
  };
}

/** Inside the entity's own menu a leading noun repeats the entity ("Aufgabe endgültig löschen" → "Endgültig löschen"). */
function withoutNoun(text: string, noun: string | undefined): string {
  if (!noun) return text;
  const prefix = `${noun} `;
  if (text.length <= prefix.length || text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return text;
  const rest = text.slice(prefix.length).trimStart();
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : text;
}

function entityType(segment: string): string | undefined {
  const type = singular(segment).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return CHAT_ENTITY_TYPE_PATTERN.test(type) ? type : undefined;
}

function idSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function staticSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment && !segment.startsWith(':'));
}

function properties(schema: JsonSchemaLike | undefined): Record<string, JsonSchemaLike> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties as Record<string, JsonSchemaLike> : {};
}

function requiredKeys(schema: JsonSchemaLike | undefined): Set<string> {
  return new Set(isRecord(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : []);
}

function stringOptions(schema: JsonSchemaLike | undefined): string[] | undefined {
  if (!isRecord(schema) || !Array.isArray(schema.enum)) return undefined;
  if (!schema.enum.every((value) => typeof value === 'string')) return undefined;
  // A blank choice is the empty field; a choice the list cannot show drops the closed set.
  const values = (schema.enum as string[]).filter((value) => value.trim().length > 0);
  return values.length > 0 && values.every((value) => value.length <= 100 && !CONTROL.test(value))
    ? values.slice(0, CHAT_INTERACTION_LIMITS.options)
    : undefined;
}

/**
 * A value the argument form can type: a string or a string enum. An array
 * (`array: 'comma' | 'repeat'` filter keys) is not typed: the form sends one
 * scalar and the bound input schema (`{ type: 'array' }`) rejects a scalar.
 */
function isStringInput(schema: JsonSchemaLike | undefined): boolean {
  if (!isRecord(schema)) return false;
  if (stringOptions(schema)) return true;
  return schema.type === 'string';
}

function argFor(
  name: string,
  schema: JsonSchemaLike | undefined,
  required: boolean,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg {
  const options = stringOptions(schema);
  const entity = options ? undefined : entityOf(name);
  const last = name.split('.').at(-1)!;
  return {
    name,
    label: clamp(humanizeIdentifier(last) || last),
    ...(required ? { required: true } : {}),
    ...(entity ? { entity } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * Arguments the user fills in for a tool, or `undefined` when a required
 * value cannot be typed in the chat (objects, numbers, booleans).
 */
function argsFor(
  input: JsonSchemaLike,
  skip: ReadonlySet<string>,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg[] | undefined {
  const required = requiredKeys(input);
  const result: ChatInteractionArg[] = [];
  for (const [name, schema] of Object.entries(properties(input)).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (skip.has(name)) continue;
    if (name === 'params' && isRecord(schema)) {
      const nestedRequired = requiredKeys(schema);
      for (const [param, paramSchema] of Object.entries(properties(schema)).sort(([left], [right]) => compareCodeUnits(left, right))) {
        if (!isStringInput(paramSchema)) return undefined;
        result.push(argFor(`params.${param}`, paramSchema, required.has('params') || nestedRequired.has(param), entityOf));
      }
      continue;
    }
    if (!FIELD.test(name)) {
      if (required.has(name)) return undefined;
      continue;
    }
    if (!isStringInput(schema)) {
      if (required.has(name)) return undefined;
      continue;
    }
    result.push(argFor(name, schema, required.has(name), entityOf));
  }
  return result.length > CHAT_INTERACTION_LIMITS.args ? undefined : result;
}

function navigationTitle(path: string): { en: string; de: string } {
  const segments = staticSegments(path);
  if (segments.length === 0) return { en: 'Home', de: 'Startseite' };
  const title = humanizeIdentifier(segments.join(' '));
  return { en: title, de: title };
}

/**
 * True when the entries pass the strict check on their own: an identifier
 * the protocol cannot carry drops its entry, never the whole refresh.
 */
function carries(entities: ReadonlyArray<ChatEntityData>, commands: ReadonlyArray<ChatCommandData>): boolean {
  try {
    parseChatInteractions({ schemaVersion: 1, entities, commands });
    return true;
  } catch {
    return false;
  }
}

interface SearchCandidate {
  type: string;
  /** The type the route names (`file` for `/api/files`): arguments named after it (`fileId`) refer to this entity. */
  routeType?: string;
  entity: ChatEntityData;
  /** Path whose item endpoints become actions (`/api/users` for `/api/users/search`). */
  collection: string;
}

/** The resource a read route lists: its last static segment, before a trailing `search`. */
function listNameOf(path: string): { listName: string; isSearchPath: boolean } | undefined {
  const segments = staticSegments(path);
  const isSearchPath = segments.at(-1) === 'search';
  if (isSearchPath && segments.length < 2) return undefined;
  return { listName: segments.at(isSearchPath ? -2 : -1) ?? '', isSearchPath };
}

/**
 * The tool's one identity declaration at the list a search reads (a
 * declaration without a path counts when it is the tool's only one), when it
 * has a type the chat can carry and a single id field.
 */
function declaredAtList(
  tool: BoundTool,
  itemsPath: ReadonlyArray<string>,
): { type: string; id: string; name?: string } | undefined {
  const all = tool.outputEntities ?? [];
  const at = all.filter((declaration) => {
    if (declaration.path === undefined) return all.length === 1;
    const path = declarationItemsPath(declaration, tool.contract.output);
    return path !== undefined && sameItemsPath(path, itemsPath);
  });
  if (at.length !== 1) return undefined;
  const declaration = at[0]!;
  const ids = entityIdFields(declaration);
  if (!declaration.type || !CHAT_ENTITY_TYPE_PATTERN.test(declaration.type) || ids.length !== 1) return undefined;
  return { type: declaration.type, id: ids[0]!, ...(declaration.name ? { name: declaration.name } : {}) };
}

/** A derived search entity; `fallback` is the route-typed entity (as before identity) when the declared type differs from the route's. */
interface DerivedCandidate {
  primary: SearchCandidate;
  fallback?: SearchCandidate;
  /** The declared identity type differs from the route type, so the candidate adopts a new type. */
  adopts: boolean;
}

/**
 * A read endpoint with a search parameter whose output is a list of objects
 * with an id and a label. Its type is the one the tool's identity declares
 * at that list, else the singular of the route; for a declared type other
 * than the route's, the route-typed entity is kept as the fallback.
 */
function searchEntity(tool: BoundTool): DerivedCandidate | undefined {
  if ((tool.method !== 'GET' && tool.method !== 'HEAD') || !tool.path || tool.path.includes(':')) return undefined;
  const query = new Set(tool.contract.params.query);
  const route = listNameOf(tool.path);
  if (!route) return undefined;
  const { listName, isSearchPath } = route;
  const queryParam = (isSearchPath ? [...SEARCH_PARAMS, 'name'] : SEARCH_PARAMS).find((name) => query.has(name));
  if (!queryParam) return undefined;
  const routeType = entityType(listName);
  if (!routeType) return undefined;
  const output = tool.contract.output;
  let itemsPath: string[] | undefined;
  let items: JsonSchemaLike | undefined;
  if (isRecord(output) && output.type === 'array') {
    itemsPath = [];
    items = output.items as JsonSchemaLike | undefined;
  } else {
    const lists = Object.entries(properties(output))
      .filter(([name, schema]) => FIELD.test(name) && isRecord(schema) && schema.type === 'array' && isRecord(schema.items));
    const preferred = lists.find(([name]) => name === listName) ?? (lists.length === 1 ? lists[0] : undefined);
    if (preferred) {
      itemsPath = [preferred[0]];
      items = (preferred[1] as Record<string, unknown>).items as JsonSchemaLike;
    }
  }
  if (!itemsPath) return undefined;
  const fields = properties(items);
  const isText = (name: string) => isRecord(fields[name]) && (fields[name] as Record<string, unknown>).type === 'string';
  const declared = declaredAtList(tool, itemsPath);
  // Which lists become an entity is decided as before, by the field-name guess: a declaration
  // names the type and the fields of such a list, it never adds one (that is `mentions.sources`).
  const guessedId = searchIdFieldCandidates(routeType).find((name) => isRecord(fields[name]));
  const guessedLabel = LABEL_FIELDS.find((name) => name !== guessedId && isText(name));
  if (!guessedId || !guessedLabel) return undefined;
  const limitParam = SEARCH_LIMIT_PARAMS.find((name) => query.has(name));
  const collection = isSearchPath ? collectionOf(tool.path) : tool.path;
  const build = (type: string, idField: string, labelField: string): SearchCandidate | undefined => {
    const descriptionField = SEARCH_DESCRIPTION_FIELDS.find((name) => name !== labelField && isText(name));
    const entity: ChatEntityData = {
      type,
      label: entityLabel(tool, type),
      search: {
        tool: tool.definitionId,
        path: tool.path!,
        queryParam,
        itemsPath: itemsPath!,
        idField,
        labelField,
        ...(descriptionField ? { descriptionField } : {}),
        ...(limitParam ? { limitParam } : {}),
      },
    };
    return carries([entity], []) ? { type, routeType, entity, collection } : undefined;
  };
  const byRoute = build(routeType, guessedId, guessedLabel);
  if (!declared) return byRoute ? { primary: byRoute, adopts: false } : undefined;
  const idField = declared.id;
  const labelField = (declared.name !== undefined && isText(declared.name) ? declared.name : undefined)
    ?? LABEL_FIELDS.find((name) => name !== idField && isText(name));
  const byDeclaration = labelField ? build(declared.type, idField, labelField) : undefined;
  if (!byDeclaration) return undefined;
  if (declared.type === routeType) return { primary: byDeclaration, adopts: false };
  return { primary: byDeclaration, ...(byRoute ? { fallback: byRoute } : {}), adopts: true };
}

/** A ready-to-paste `mentions.sources` entry for a derived candidate. */
function sourceEntryOf(candidate: SearchCandidate): Record<string, unknown> {
  const search = candidate.entity.search!;
  return {
    tool: search.tool,
    queryParam: search.queryParam,
    labelField: search.labelField,
    idField: search.idField,
    itemsPath: [...search.itemsPath],
    ...(search.descriptionField ? { descriptionField: search.descriptionField } : {}),
    ...(search.limitParam ? { limitParam: search.limitParam } : {}),
  };
}

/**
 * Derives the chat's `@` entities and `/` commands from the enabled tools,
 * a pure function of the setup artifact and the tool contracts:
 *
 * - entities from read endpoints with a search parameter (`search`, `q`,
 *   `query`, `term`) whose output lists objects with an id and a label;
 * - entity actions from endpoints with exactly one path parameter below the
 *   entity's collection (`PATCH /api/tasks/:id`), and "Open" from pages with
 *   one parameter of the entity (`/tasks/:taskId`);
 * - commands from navigation (one per page without parameters), URL
 *   filters and client actions.
 *
 * Labels come from the tool's reviewed title and the presentation noun where
 * the app has them, else from identifiers; overrides replace them. Bounded and sorted, so the module stays byte-stable;
 * an entry the protocol cannot carry is dropped alone, so app code never
 * makes the generated module (and `tools refresh`) fail here.
 */
export function deriveChatInteractions(input: DeriveChatInteractionsInput): ChatInteractionsData {
  return analyzeChatInteractions(input).data;
}

/**
 * `deriveChatInteractions` with its findings about tools.json `mentions`:
 * invalid and undeclared sources, candidates a `declared` policy leaves
 * out, and derived types that changed to the declared identity type.
 *
 * Entities come in the order of the `@` menu groups: the declared sources
 * in the key order of `mentions.sources`, then (policy `derived`) the
 * derived ones by type. A declared source replaces a derived candidate of
 * its type or its tool; `mentions.ignore` drops derived types.
 */
export function analyzeChatInteractions(input: DeriveChatInteractionsInput): {
  data: ChatInteractionsData;
  findings: ToolFinding[];
} {
  const contracts = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools: BoundTool[] = input.artifact.tools
    .filter((tool) => tool.enabled)
    .flatMap((tool): BoundTool[] => {
      const entry = contracts.get(tool.toolId);
      if (!entry?.contract) return [];
      const title = safeTitle(entry.title);
      const presentation = tool.presentation;
      // The templated fallback repeats the tool label in all three texts; only a reviewed one names the thing.
      const reviewed = presentation && !(presentation.singular === presentation.plural && presentation.plural === presentation.approval);
      const locale = reviewed ? presentation.locale.toLowerCase() : undefined;
      const language = locale?.startsWith('de') ? 'de' : locale?.startsWith('en') ? 'en' : undefined;
      const noun = language ? safe(presentation?.singular) : undefined;
      return [{
        definitionId: tool.name, method: tool.method, path: tool.path, contract: entry.contract, riskClass: tool.riskClass,
        ...(title ? { title } : {}),
        ...(language && noun ? { noun: { language, text: noun } } : {}),
        ...(entry.labels ? { labels: entry.labels } : {}),
        ...(entry.outputEntities ? { outputEntities: entry.outputEntities } : {}),
      }];
    })
    .sort((left, right) => compareCodeUnits(left.definitionId, right.definitionId));

  const mentions = input.mentions ?? {};
  const config = TOOLS_PATHS.config;
  const findings: ToolFinding[] = [];

  // Declared sources first, in their key order; checked against every tool, so a disabled one is named as such.
  const mentionTools: MentionTool[] = input.artifact.tools.map((tool) => {
    const entry = contracts.get(tool.toolId);
    return {
      definitionId: tool.name,
      modelName: tool.modelName ?? tool.name.replace(/\./g, '_'),
      enabled: tool.enabled,
      executionKind: tool.executionKind,
      ...(tool.method ? { method: tool.method } : {}),
      ...(tool.path ? { path: tool.path } : {}),
      ...(entry?.contract ? { contract: entry.contract } : {}),
      ...(entry?.outputEntities ? { outputEntities: entry.outputEntities } : {}),
    };
  });
  const declaredSources = resolveMentionSources(mentions.sources, mentionTools);
  findings.push(...declaredSources.findings);
  const boundById = new Map(tools.map((tool) => [tool.definitionId, tool] as const));
  const declared: SearchCandidate[] = declaredSources.sources.flatMap((source) => {
    const tool = boundById.get(source.tool.definitionId);
    if (!tool) return [];
    const route = listNameOf(source.search.path);
    const routeType = route ? entityType(route.listName) : undefined;
    const entity: ChatEntityData = {
      type: source.type,
      label: source.label ?? entityLabel(tool, source.type),
      ...(source.aliases !== undefined ? { aliases: source.aliases } : {}),
      search: source.search,
    };
    return [{
      type: source.type,
      ...(routeType ? { routeType } : {}),
      entity,
      collection: route?.isSearchPath ? collectionOf(source.search.path) : source.search.path,
    }];
  });

  // Derived candidates: a declared identity type is adopted only when it is unique among the
  // final types of all derived candidates and no other tool's declared source; otherwise every
  // candidate involved keeps its route type, as before identity. Then one per type (the first by path).
  const declaredTypes = new Set(declared.map((candidate) => candidate.type));
  const declaredTools = new Set(declared.map((candidate) => candidate.entity.search!.tool));
  const ignored = new Set(mentions.ignore ?? []);
  const candidates = tools
    .map(searchEntity)
    .filter((entry): entry is DerivedCandidate => entry !== undefined)
    .filter((entry) => !declaredTools.has(entry.primary.entity.search!.tool))
    .sort((left, right) => compareCodeUnits(left.primary.entity.search!.path, right.primary.entity.search!.path));
  const fallen = new Set<DerivedCandidate>();
  const current = (candidate: DerivedCandidate): SearchCandidate | undefined =>
    fallen.has(candidate) ? candidate.fallback : candidate.primary;
  for (let changed = true; changed;) {
    changed = false;
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const type = current(candidate)?.type;
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      if (!candidate.adopts || fallen.has(candidate)) continue;
      const type = candidate.primary.type;
      if ((counts.get(type) ?? 0) > 1 || declaredTypes.has(type)) {
        fallen.add(candidate);
        changed = true;
      }
    }
  }
  const derived = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const chosen = current(candidate);
    if (!chosen || declaredTypes.has(chosen.type) || ignored.has(chosen.type)) continue;
    if (!derived.has(chosen.type)) derived.set(chosen.type, chosen);
  }
  const derivedByType = [...derived.values()].sort((left, right) => compareCodeUnits(left.type, right.type));
  if (mentions.policy !== 'declared') {
    const ambiguous = [...new Set([...fallen].map((candidate) => candidate.primary.type))].sort(compareCodeUnits);
    for (const type of ambiguous) {
      const involved = candidates.filter((candidate) => (fallen.has(candidate) && candidate.primary.type === type)
        || current(candidate)?.type === type);
      const named = involved.map((candidate) => {
        const kept = current(candidate);
        const search = candidate.primary.entity.search!;
        return `${search.tool} (${search.path}${fallen.has(candidate) ? `, kept as ${kept ? kept.type : 'no entity'}` : ''})`;
      });
      const source = declared.find((candidate) => candidate.type === type);
      findings.push(toolFinding('mention-type-ambiguous', 'warning', `${config}#mentions.sources.${type}`,
        `The identity type ${type} is not unique among the @ entities: ${named.join(', ')}`
        + `${source ? `; mentions.sources.${type} already names ${source.entity.search!.tool}` : ''}`
        + (source
          ? `. So the others keep their route types as before; to leave one of them out of the @ menu, add its route type to mentions.ignore.`
          : `. So none of them adopts ${type} and each keeps its route type as before; to offer the wanted one as ${type}, declare it under mentions.sources.${type}.`)));
    }
  }
  if (mentions.policy === 'declared') {
    for (const candidate of derivedByType) {
      const entry = sourceEntryOf(candidate);
      findings.push({
        ...toolFinding('mention-source-candidate', 'warning', `${config}#mentions.sources.${candidate.type}`,
          `${candidate.entity.search!.tool} (${candidate.entity.search!.path}) can search the entity type ${candidate.type}, which policy "declared" does not offer; `
          + `to offer it, add to mentions.sources: ${JSON.stringify({ [candidate.type]: entry })}.`),
        expected: { [candidate.type]: entry },
      });
    }
  } else {
    const acknowledged = new Set(mentions.acknowledgedTypes ?? []);
    for (const candidate of derivedByType) {
      if (!candidate.routeType || candidate.routeType === candidate.type || acknowledged.has(candidate.type)) continue;
      if (Object.hasOwn(mentions.sources ?? {}, candidate.type)) continue;
      findings.push(toolFinding('mention-type-follows-identity', 'warning', `${config}#mentions.acknowledgedTypes.${candidate.type}`,
        `The @ entity of ${candidate.entity.search!.tool} is now of the declared identity type ${candidate.type} instead of ${candidate.routeType}: `
        + `its action ids change too (${candidate.routeType}.… → ${candidate.type}.…), so overrides under entities.${candidate.routeType} `
        + `and under the old action ids in .glirastes/chat-interactions.json, hidden: true patches included, no longer apply, `
        + `and stored {{mention:${candidate.routeType}:…}} markers refer to the old name.`));
    }
  }

  const searches = new Map<string, SearchCandidate>();
  for (const candidate of [...declared, ...(mentions.policy === 'declared' ? [] : derivedByType)]) {
    if (!searches.has(candidate.type)) searches.set(candidate.type, candidate);
  }
  // An argument or page parameter names an entity by its type, or by the type its route names (`fileId` → `media-file`).
  const typeFor = new Map<string, string>([...searches.keys()].map((type) => [type, type] as const));
  for (const candidate of searches.values()) {
    if (candidate.routeType && !typeFor.has(candidate.routeType)) typeFor.set(candidate.routeType, candidate.type);
  }
  const typeOf = (word: string | undefined): string | undefined => {
    const type = word ? entityType(word) : undefined;
    return type ? typeFor.get(type) : undefined;
  };
  const entityOf = (name: string): string | undefined => typeOf(idParameterStem(name));

  const actions = new Map<string, ChatEntityActionData[]>();
  const destructive = new Set<string>();
  const addAction = (type: string, action: ChatEntityActionData, isDestructive = false) => {
    if (!carries([{ type, label: type, actions: [action] }], [])) return;
    const list = actions.get(type) ?? [];
    if (!list.some((entry) => entry.id === action.id)) list.push(isDestructive ? { ...action, destructive: true } : action);
    if (isDestructive) destructive.add(action.id);
    actions.set(type, list);
  };
  for (const { type, entity, collection } of searches.values()) {
    for (const tool of tools) {
      if (!tool.path || tool.contract.uiAction) continue;
      const match = new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/:([A-Za-z_][A-Za-z0-9_]*)(?:/([A-Za-z0-9_-]+))?$`)
        .exec(tool.path);
      if (!match || tool.contract.params.path.length !== 1) continue;
      const entityArg = match[1]!;
      const args = argsFor(tool.contract.input, new Set([entityArg]), entityOf);
      if (!args) continue;
      const label = clampLabel(actionLabel({
        definitionId: tool.definitionId, method: tool.method, trailingSegment: match[2], title: tool.title,
      }));
      addAction(type, {
        id: `${type}.${tool.definitionId}`,
        // Every language of the label; inside the entity's menu each drops the entity's noun in that language.
        label: Object.fromEntries(Object.entries(label)
          .map(([language, text]) => [language, withoutNoun(text, nounOf(entity, language))] as const)),
        entityArg,
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'tool', tool: tool.definitionId },
      }, tool.riskClass === 'delete' || tool.method === 'DELETE');
    }
  }

  const commands: ChatCommandData[] = [];
  const commandIds = new Set<string>();
  const addCommand = (command: ChatCommandData) => {
    if (commandIds.has(command.id) || !carries([], [command])) return;
    commandIds.add(command.id);
    commands.push(command);
  };
  for (const tool of tools) {
    const action = tool.contract.uiAction;
    if (!action) continue;
    if (action.kind === 'navigate') {
      const destination = properties(tool.contract.input).destination;
      const paths = isRecord(destination) && Array.isArray(destination.enum)
        ? destination.enum.filter((value): value is string => typeof value === 'string')
        : [];
      for (const path of paths) {
        const params = path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
        if (params.length === 0) {
          const title = navigationTitle(path);
          const segments = staticSegments(path);
          addCommand({
            id: `open.${segments.length > 0 ? segments.map(idSegment).join('.') : 'home'}`,
            label: { en: clamp(`Open ${title.en}`), de: clamp(`${title.de} öffnen`) },
            ...(segments.length > 0 ? { keywords: segments.slice(0, CHAT_INTERACTION_LIMITS.keywords).map((segment) => clamp(segment, 60)) } : {}),
            run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
          });
          continue;
        }
        if (params.length !== 1) continue;
        const segments = path.split('/');
        const index = segments.indexOf(`:${params[0]}`);
        const type = entityOf(params[0]!) ?? (isBareIdParameter(params[0]!) && index > 0 ? typeOf(segments[index - 1]!) : undefined);
        if (!type || !searches.has(type)) continue;
        addAction(type, {
          id: `${type}.open`,
          label: { en: 'Open', de: 'Öffnen' },
          entityArg: `params.${params[0]}`,
          run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
        });
      }
      continue;
    }
    if (action.kind === 'client-action' && CHAT_INTERNAL_ACTION.test(action.actionId)) continue;
    const args = argsFor(tool.contract.input, new Set(), entityOf);
    if (!args) continue;
    if (action.kind === 'filter') {
      const view = tool.definitionId.replace(/^ui\.filter\./, '');
      const title = humanizeIdentifier(view);
      addCommand({
        id: `filter.${idSegment(view)}`,
        label: {
          ...otherTitleLanguages(tool.title),
          en: titleIn(tool.title, 'en') ?? clamp(`Filter ${title}`),
          de: titleIn(tool.title, 'de') ?? clamp(`${title} filtern`),
        },
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'ui', tool: tool.definitionId },
      });
      continue;
    }
    const id = tool.definitionId.replace(/^ui\./, '');
    addCommand({
      id,
      label: clampLabel(commandLabel(id, tool.title)),
      ...(args.length > 0 ? { args } : {}),
      run: { kind: 'ui', tool: tool.definitionId },
    });
  }

  const entities = [...searches.values()]
    .map(({ type, entity }) => {
      const list = (actions.get(type) ?? [])
        .sort((left, right) => (Number(destructive.has(left.id)) - Number(destructive.has(right.id)))
          || compareCodeUnits(left.id, right.id))
        .slice(0, CHAT_INTERACTION_LIMITS.actionsPerEntity);
      return list.length > 0 ? { ...entity, actions: list } : entity;
    })
    .slice(0, CHAT_INTERACTION_LIMITS.entities);
  const data = parseChatInteractions({
    schemaVersion: 1,
    entities,
    commands: commands
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .slice(0, CHAT_INTERACTION_LIMITS.commands),
  });
  return { data, findings };
}
