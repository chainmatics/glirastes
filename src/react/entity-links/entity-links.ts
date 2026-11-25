import { buildNavigationHref } from '../../browser/navigation.js';
import type { ChatEntitySearchData } from '../../contracts/chat-interactions.js';
import type { ChatEntityDefinition } from '../interactions/definitions.js';
import { parseMentionSegments } from '../utils/mention-markup.js';
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import {
  declarationsForRead,
  declaredRecordsOf,
  entityIdText,
  entityLookupId,
  type DeclaredRecordIdentity,
  type EntityDeclarationsByTool,
} from '../../contracts/entity-declaration.js';

/** One entity an assistant message refers to. */
export interface ChatEntityReference {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  /**
   * Free data of the app for `open` (a route, a tenant, a version), as a
   * matcher's `resolve`, `knownEntities` or `resolveAmbiguous` returned it.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Recognises references of one type in assistant text, e.g. task keys
 * (`/[A-Z][A-Z0-9]{1,5}-\d+/`). Matches count only as whole words.
 */
export interface ChatEntityMatcher {
  readonly type: string;
  readonly pattern: RegExp;
  /**
   * Id and label of a match; `undefined` leaves it as text (e.g. not visible
   * to this user). Without `resolve` the matched text is id and label.
   * Results are cached per matched text for the provider's lifetime.
   */
  resolve?(match: string): Promise<Omit<ChatEntityReference, 'type'> | undefined> | Omit<ChatEntityReference, 'type'> | undefined;
}

/** What `knownEntities` gets: the conversation the chat shows. */
export interface ChatEntityLinksContext {
  readonly messages: ReadonlyArray<{ readonly role?: string; readonly parts: ReadonlyArray<unknown> }>;
}

export interface ChatEntityLinksConfig {
  /** App-specific recognisers, e.g. task identifiers. */
  readonly matchers?: ReadonlyArray<ChatEntityMatcher>;
  /**
   * Also link the names of entities the conversation already referenced:
   * `@` mentions and the hits of an entity's search tool. Default true.
   */
  readonly known?: boolean;
  /** Shorter known names stay text; they collide with ordinary words. Default 4. */
  readonly minLabelLength?: number;
  /**
   * Further known references the app derives from the conversation (D3),
   * merged after the built-in ones; called when the messages change.
   * Memoize the function.
   */
  knownEntities?(context: ChatEntityLinksContext): ReadonlyArray<ChatEntityReference>;
  /**
   * When two known references share a name (two playlists "Lobby Loop"):
   * `text` (default since 0.18.0) leaves the name as text, `first` links the
   * first one found (the default before). `resolveAmbiguous` decides instead
   * when given. Name matches only: a `{{mention:type:id:label}}` marker or a
   * `@` mention carries its id and becomes a chip by that id, whatever other
   * record has the same name (`verifyMentions` still applies).
   */
  readonly ambiguousNames?: 'first' | 'text';
  /** Picks the reference for a name several known references share; `undefined` leaves it as text. */
  resolveAmbiguous?(label: string, candidates: ReadonlyArray<ChatEntityReference>): ChatEntityReference | undefined;
  /** `all` (default) links in every message, `assistant` only in the assistant's text. */
  readonly scope?: 'all' | 'assistant';
  /**
   * `{{mention:type:id:label}}` markers in an assistant's text.
   * `'plain'` (default, as before): a text part with a marker renders
   * without Markdown, each marker a chip. `'markdown'`: the text keeps its
   * Markdown and each marker becomes a chip inside it (with a custom
   * `components.Markdown`, through `markdownComponents`).
   */
  readonly mentionMarkers?: 'plain' | 'markdown';
  /**
   * With `mentionMarkers: 'markdown'`: a marker becomes a chip only when the
   * conversation showed its id as a record, by declaration only (the tools'
   * `outputEntities`, a `@` mention the user picked, an entity search hit);
   * otherwise its label stays text. Never a field-name guess, so without
   * declarations every marker stays text. Default true; `false` turns the
   * check off. A checked marker links by its id, also where another record
   * has the same name.
   */
  readonly verifyMentions?: boolean;
  /**
   * Opens a reference. Return `false` to fall through to the default: the
   * entity's action that runs `ui.navigate` (a page like `/tasks/:taskId`),
   * through the app's navigation bridge. Without either a chip is not clickable.
   */
  open?(reference: ChatEntityReference): boolean | void;
  /** Whether `open` handles this type; default: every type. */
  canOpen?(type: string): boolean;
}

export type ChatEntityTextSegment =
  | { readonly kind: 'text'; readonly text: string }
  /**
   * A matcher hit; `resolve` decides later whether it becomes a chip. A known
   * name right after the hit ("MAR-5 Flyer drucken") joins it: `text` is the
   * whole phrase, `match` the hit that `resolve` gets.
   */
  | { readonly kind: 'match'; readonly type: string; readonly text: string; readonly matcher: number; readonly match?: string }
  | { readonly kind: 'entity'; readonly text: string; readonly reference: ChatEntityReference };

const WORD = '[\\p{L}\\p{N}_]';

/** Compiles a regex; the provider passes a cache so a pattern is compiled once, not per text. */
export type CompileRegex = (source: string, flags: string) => RegExp;

const compileRegex: CompileRegex = (source, flags) => new RegExp(source, flags);

function boundaryPattern(source: string, flags: string, compile: CompileRegex): RegExp {
  const extra = [...new Set(flags.replace(/[gyu]/g, ''))].join('');
  return compile(`(?<!${WORD})(?:${source})(?!${WORD})`, `gu${extra}`);
}

/**
 * A `CompileRegex` that keeps the last `limit` compiled patterns by source and
 * flags. The regexes are stateful (`g`/`y`): every use sets `lastIndex` first.
 */
export function createRegexCache(limit = 64): CompileRegex {
  const compiled = new Map<string, RegExp>();
  return (source, flags) => {
    const key = `${flags}/${source}`;
    let regex = compiled.get(key);
    if (regex) {
      compiled.delete(key);
    } else {
      regex = new RegExp(source, flags);
      if (compiled.size >= limit) compiled.delete(compiled.keys().next().value!);
    }
    compiled.set(key, regex);
    return regex;
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What `splitEntityText` and `createEntityTextSplitter` read. */
export interface EntityTextSplitOptions {
  readonly matchers?: ReadonlyArray<Pick<ChatEntityMatcher, 'type' | 'pattern'>>;
  readonly known?: ReadonlyArray<ChatEntityReference>;
  readonly minLabelLength?: number;
  readonly ambiguousNames?: 'first' | 'text';
  readonly resolveAmbiguous?: (label: string, candidates: ReadonlyArray<ChatEntityReference>) => ChatEntityReference | undefined;
}

/**
 * Splits text into plain parts, matcher hits and known entity names. The
 * earliest match wins; at the same position the longer one.
 */
export function splitEntityText(text: string, options: EntityTextSplitOptions = {}): ChatEntityTextSegment[] {
  return createEntityTextSplitter(options)(text);
}

/**
 * `splitEntityText` for many texts with the same options: the names and the
 * matcher patterns are prepared once, on the first text. A name several known
 * references share is decided on every text, as by `splitEntityText`
 * (`resolveAmbiguous` is asked each time); the name pattern is compiled once
 * per set of names that link.
 */
export function createEntityTextSplitter(
  options: EntityTextSplitOptions,
  compile: CompileRegex = compileRegex,
): (text: string) => ChatEntityTextSegment[] {
  let names: KnownNames | undefined;
  return (text) => {
    names ??= knownNames(options, compile);
    return splitPrepared(text, options, names.pick());
  };
}

interface PreparedSplit {
  readonly byLabel: { get(label: string): ChatEntityReference | undefined };
  readonly patterns: ReadonlyArray<{ regex: RegExp; matcher?: number }>;
  readonly trailingLabel?: RegExp;
}

interface KnownNames {
  /** The names that link for one text, with their patterns. */
  pick(): PreparedSplit;
}

function knownNames(options: EntityTextSplitOptions, compile: CompileRegex): KnownNames {
  const minLength = options.minLabelLength ?? 4;
  // Since 0.18.0 a name several records share stays text unless `ambiguousNames: 'first'` (the behaviour before).
  const decide = options.resolveAmbiguous !== undefined || options.ambiguousNames !== 'first';
  const first = new Map<string, ChatEntityReference>();
  const candidates = new Map<string, ChatEntityReference[]>();
  for (const reference of options.known ?? []) {
    const label = reference.label.trim();
    if (label.length < minLength) continue;
    if (!decide) {
      if (!first.has(label)) first.set(label, reference);
      continue;
    }
    const list = candidates.get(label) ?? [];
    const same = (known: ChatEntityReference) => known.type === reference.type && known.id === reference.id
      && JSON.stringify(known.data?.idValues) === JSON.stringify(reference.data?.idValues);
    if (!list.some(same)) list.push(reference);
    candidates.set(label, list);
  }
  const matcherPatterns = (options.matchers ?? []).map((matcher, index) => ({
    regex: boundaryPattern(matcher.pattern.source, matcher.pattern.flags, compile),
    matcher: index,
  }));
  const withNames = (labels: ReadonlyArray<string>): Omit<PreparedSplit, 'byLabel'> => {
    const sorted = [...labels].sort((a, b) => b.length - a.length).map(escapeRegex);
    if (sorted.length === 0) return { patterns: matcherPatterns };
    const alternatives = sorted.join('|');
    return {
      patterns: [...matcherPatterns, { regex: boundaryPattern(alternatives, '', compile) }],
      trailingLabel: compile(`[ \\t]*(?:[:\u2013\u2014-][ \\t]*)?(?:${alternatives})(?!${WORD})`, 'uy'),
    };
  };
  if (!decide) {
    const fixed: PreparedSplit = { byLabel: first, ...withNames([...first.keys()]) };
    return { pick: () => fixed };
  }
  const entries = [...candidates];
  const ambiguous = entries.filter(([, list]) => list.length > 1);
  const single = new Map(entries.filter(([, list]) => list.length === 1).map(([label, list]) => [label, list[0]!]));
  if (ambiguous.length === 0 || !options.resolveAmbiguous) {
    // Nobody to ask: a shared name stays text.
    const fixed: PreparedSplit = { byLabel: single, ...withNames([...single.keys()]) };
    return { pick: () => fixed };
  }
  const resolveAmbiguous = options.resolveAmbiguous;
  // The patterns per set of picked names, keyed by which shared names link.
  const bySet = new Map<string, Omit<PreparedSplit, 'byLabel'>>();
  return {
    pick() {
      const picks = new Map<string, ChatEntityReference>();
      let key = '';
      for (const [label, list] of ambiguous) {
        const picked = resolveAmbiguous(label, [...list]);
        key += picked ? '1' : '0';
        if (picked) picks.set(label, picked);
      }
      let patterns = bySet.get(key);
      if (!patterns) {
        patterns = withNames(entries.filter(([label, list]) => list.length === 1 || picks.has(label)).map(([label]) => label));
        if (bySet.size >= 16) bySet.delete(bySet.keys().next().value!);
        bySet.set(key, patterns);
      }
      return { byLabel: { get: (label) => single.get(label) ?? picks.get(label) }, ...patterns };
    },
  };
}

function splitPrepared(text: string, options: EntityTextSplitOptions, prepared: PreparedSplit): ChatEntityTextSegment[] {
  const { byLabel, patterns, trailingLabel } = prepared;
  if (patterns.length === 0 || !text) return [{ kind: 'text', text }];

  const segments: ChatEntityTextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let best: { index: number; length: number; matcher?: number; value: string } | undefined;
    for (const { regex, matcher } of patterns) {
      regex.lastIndex = cursor;
      const found = regex.exec(text);
      if (!found || found[0].length === 0) continue;
      if (!best || found.index < best.index || (found.index === best.index && found[0].length > best.length)) {
        best = { index: found.index, length: found[0].length, matcher, value: found[0] };
      }
    }
    if (!best) break;
    if (best.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, best.index) });
    if (best.matcher !== undefined) {
      const type = options.matchers![best.matcher]!.type;
      let joined: string | undefined;
      if (trailingLabel) {
        trailingLabel.lastIndex = best.index + best.length;
        joined = trailingLabel.exec(text)?.[0];
      }
      if (joined) {
        segments.push({ kind: 'match', type, text: best.value + joined, matcher: best.matcher, match: best.value });
        best.length += joined.length;
      } else {
        segments.push({ kind: 'match', type, text: best.value, matcher: best.matcher });
      }
    } else {
      segments.push({ kind: 'entity', text: best.value, reference: byLabel.get(best.value)! });
    }
    cursor = best.index + best.length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function toolKey(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

function toolOutputOf(part: unknown): { tool: string; output: unknown } | undefined {
  if (!isRecord(part)) return undefined;
  const type = typeof part.type === 'string' ? part.type : '';
  if (type.startsWith('tool-') && type !== 'tool-result' && part.state === 'output-available') {
    return { tool: type.slice('tool-'.length), output: part.output };
  }
  if (type === 'tool-result' && typeof part.toolName === 'string') return { tool: part.toolName, output: part.result };
  if (typeof part.toolName === 'string' && 'result' in part) return { tool: part.toolName, output: part.result };
  return undefined;
}

type ConversationMessage = { readonly role?: string; readonly parts: ReadonlyArray<unknown> };
type EntitySearches = ReadonlyArray<{ readonly type: string; readonly search: ChatEntitySearchData }>;
type SearchesByTool = ReadonlyMap<string, EntitySearches[number]>;

function searchesByTool(searches: EntitySearches): SearchesByTool {
  return new Map(searches.map((entry) => [toolKey(entry.search.tool), entry]));
}

/** One known reference of a message under its dedup key, in the order the message names it. */
type KnownEntry = readonly [key: string, reference: ChatEntityReference];

/** The `read_result` lookups a message's records depended on, to tell when a later producer changes them. */
interface ReadDependency {
  readonly id: string;
  readonly tool: string | undefined;
  readonly output: unknown;
}

/**
 * Entities a conversation already names: `{{mention:type:id:label}}` markers
 * in any message and the items of an entity search tool's results.
 */
export function collectKnownEntities(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<unknown> }>,
  searches: EntitySearches = [],
  declarations?: EntityDeclarationsByTool,
): ChatEntityReference[] {
  const byTool = searchesByTool(searches);
  const producers = declarations ? resultProducers(messages) : undefined;
  return mergeKnown(messages.map((message) => knownOfMessage(message, byTool, declarations, producers)));
}

/** The first reference under each key wins, in conversation order. */
function mergeKnown(perMessage: Iterable<ReadonlyArray<KnownEntry>>): ChatEntityReference[] {
  const found = new Map<string, ChatEntityReference>();
  for (const entries of perMessage) {
    for (const [key, reference] of entries) {
      if (!found.has(key)) found.set(key, reference);
    }
  }
  return [...found.values()];
}

function knownOfMessage(
  message: { readonly parts: ReadonlyArray<unknown> },
  byTool: SearchesByTool,
  declarations: EntityDeclarationsByTool | undefined,
  producers: ResultProducers | undefined,
  reads?: ReadDependency[],
): KnownEntry[] {
  const entries: KnownEntry[] = [];
  const add = (reference: ChatEntityReference, lookup?: string) => {
    entries.push([`${reference.type}\u0000${lookup ?? reference.id}`, reference]);
  };
  for (const part of message.parts) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      for (const segment of parseMentionSegments(part.text)) {
        if (segment.kind !== 'mention' || segment.mention.type === 'command') continue;
        add({ type: segment.mention.type, id: segment.mention.id, label: segment.mention.displayName });
      }
      continue;
    }
    const result = toolOutputOf(part);
    // A tool whose `outputEntities` declare a type and a name: every such record, also nested (D1).
    for (const identity of result && producers ? declaredIdentitiesOf(part, result, declarations!, producers, reads) : []) {
      if (identity.declaration.type && identity.name) {
        // A composite key: readable id, its parts in `data`; told apart by its tuple.
        const composite = identity.idValues.length > 1;
        add({
          type: identity.declaration.type, id: entityIdText(identity.idValues), label: identity.name,
          ...(composite ? { data: { idValues: [...identity.idValues] } } : {}),
        }, composite ? String(entityLookupId(identity.idValues)) : undefined);
      }
    }
    const entry = result ? byTool.get(toolKey(result.tool)) : undefined;
    if (!result || !entry) continue;
    const { search, type } = entry;
    for (const candidate of [result.output, at(result.output, ['data']), at(result.output, ['value'])]) {
      const list = search.itemsPath.length ? at(candidate, search.itemsPath) : candidate;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const id = at(item, [search.idField]);
        const label = at(item, [search.labelField]);
        if ((typeof id === 'string' || typeof id === 'number') && typeof label === 'string' && label.trim()) {
          add({ type, id: String(id), label: label.trim() });
        }
      }
      break;
    }
  }
  return entries;
}

/** A `read_result` answer belongs to the tool that produced the result it reads. */
interface ResultProducers {
  tools: Map<string, string>;
  outputs: Map<string, unknown>;
}

type ProducerEntry = readonly [id: string, tool: string, output: unknown];

function resultProducers(messages: ReadonlyArray<{ readonly parts: ReadonlyArray<unknown> }>): ResultProducers {
  return mergeProducers(messages.map(producersOfMessage));
}

/** A later result with the same id wins, as before. */
function mergeProducers(perMessage: Iterable<ReadonlyArray<ProducerEntry>>): ResultProducers {
  const tools = new Map<string, string>();
  const outputs = new Map<string, unknown>();
  for (const entries of perMessage) {
    for (const [id, tool, output] of entries) {
      tools.set(id, tool);
      outputs.set(id, output);
    }
  }
  return { tools, outputs };
}

function producersOfMessage(message: { readonly parts: ReadonlyArray<unknown> }): ProducerEntry[] {
  const entries: ProducerEntry[] = [];
  for (const part of message.parts) {
    const result = toolOutputOf(part);
    const marker = result && isRecord(result.output) ? result.output._result : undefined;
    if (result && result.tool !== READ_RESULT_TOOL_NAME && isRecord(marker) && typeof marker.id === 'string') {
      entries.push([marker.id, result.tool, result.output]);
    }
  }
  return entries;
}

/** The records of one tool result its tool's `outputEntities` declare (a read: the producing tool's). */
function declaredIdentitiesOf(
  part: unknown,
  result: { tool: string; output: unknown },
  declarations: EntityDeclarationsByTool,
  producers: ResultProducers,
  reads?: ReadDependency[],
): Iterable<DeclaredRecordIdentity> {
  const readId = result.tool === READ_RESULT_TOOL_NAME && isRecord(part) && isRecord(part.input)
    && typeof part.input.resultId === 'string' ? part.input.resultId : undefined;
  if (readId !== undefined) reads?.push({ id: readId, tool: producers.tools.get(readId), output: producers.outputs.get(readId) });
  const producer = readId !== undefined ? producers.tools.get(readId) ?? result.tool : result.tool;
  const own = Object.prototype.hasOwnProperty.call(declarations, producer) ? declarations[producer]!.output : undefined;
  // A read keeps the path a path-less declaration had in the producing result.
  const declared = readId !== undefined && producer !== result.tool ? declarationsForRead(own, producers.outputs.get(readId)) : own;
  return declared ? declaredRecordsOf(result.output, declared).values() : [];
}

/**
 * The `type`/`id` pairs a conversation showed as records by declaration
 * only, never by a field-name guess: the records the tools' `outputEntities`
 * declare (key `type\u0000id`, or `\u0000id` for a declaration without a
 * type), the `@` mentions the user picked and the hits of an entity search
 * tool. An assistant's own markers do not count.
 */
export function collectSeenReferenceKeys(
  messages: ReadonlyArray<ConversationMessage>,
  searches: EntitySearches = [],
  declarations?: EntityDeclarationsByTool,
): Set<string> {
  const byTool = searchesByTool(searches);
  const producers = declarations ? resultProducers(messages) : undefined;
  const keys = new Set<string>();
  for (const message of messages) {
    for (const key of seenOfMessage(message, byTool, declarations, producers)) keys.add(key);
  }
  return keys;
}

function seenOfMessage(
  message: ConversationMessage,
  byTool: SearchesByTool,
  declarations: EntityDeclarationsByTool | undefined,
  producers: ResultProducers | undefined,
  reads?: ReadDependency[],
): string[] {
  const keys: string[] = [];
  for (const part of message.parts) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      if (message.role !== 'user') continue;
      for (const segment of parseMentionSegments(part.text)) {
        if (segment.kind === 'mention' && segment.mention.type !== 'command') keys.push(referenceKey(segment.mention.type, segment.mention.id));
      }
      continue;
    }
    const result = toolOutputOf(part);
    if (!result) continue;
    for (const identity of producers ? declaredIdentitiesOf(part, result, declarations!, producers, reads) : []) {
      keys.push(referenceKey(identity.declaration.type ?? '', entityIdText(identity.idValues)));
    }
    const entry = byTool.get(toolKey(result.tool));
    if (!entry) continue;
    for (const candidate of [result.output, at(result.output, ['data']), at(result.output, ['value'])]) {
      const list = entry.search.itemsPath.length ? at(candidate, entry.search.itemsPath) : candidate;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const id = at(item, [entry.search.idField]);
        if (typeof id === 'string' || typeof id === 'number') keys.push(referenceKey(entry.type, String(id)));
      }
      break;
    }
  }
  return keys;
}

/**
 * `collectKnownEntities` and `collectSeenReferenceKeys` for a conversation
 * that changes one message at a time, as while an answer streams. What a
 * message contributes is kept per message object and read again only when
 * the message is a new object; its `parts` array, `role` or number of parts
 * changed; a part is a new object or its `type`, `text`, `state`,
 * `toolName`, `input`, `output` or `result` is a new value; the searches or
 * declarations are new objects; or a `read_result` it holds now reads
 * another producer. Not noticed: a change inside the same `input`, `output`
 * or `result` object, or inside the same declarations object (the AI SDK
 * replaces a changed message with a new copy). A result equal to the last
 * one is returned as the same object. The caches are weak: a message nobody
 * holds any more is released.
 */
export interface ConversationEntityIndex {
  known(messages: ReadonlyArray<ConversationMessage>, searches: EntitySearches, declarations?: EntityDeclarationsByTool): ReadonlyArray<ChatEntityReference>;
  seen(messages: ReadonlyArray<ConversationMessage>, searches: EntitySearches, declarations?: EntityDeclarationsByTool): ReadonlySet<string>;
}

interface MessageContribution<T> {
  readonly shape: unknown[];
  readonly searches: EntitySearches;
  readonly declarations: EntityDeclarationsByTool | undefined;
  readonly reads: ReadonlyArray<ReadDependency>;
  readonly value: T;
}

/** What a part's contribution reads directly; compared by identity to notice a part changed in place. */
function shapeOf(message: ConversationMessage): unknown[] {
  const shape: unknown[] = [message.parts, message.role, message.parts.length];
  for (const part of message.parts) {
    shape.push(part);
    if (isRecord(part)) shape.push(part.type, part.text, part.state, part.toolName, part.input, part.output, part.result);
  }
  return shape;
}

function sameShape(shape: ReadonlyArray<unknown>, message: ConversationMessage): boolean {
  if (shape[0] !== message.parts || shape[1] !== message.role || shape[2] !== message.parts.length) return false;
  let index = 3;
  for (const part of message.parts) {
    if (shape[index++] !== part) return false;
    if (!isRecord(part)) continue;
    if (shape[index++] !== part.type || shape[index++] !== part.text || shape[index++] !== part.state
      || shape[index++] !== part.toolName || shape[index++] !== part.input || shape[index++] !== part.output
      || shape[index++] !== part.result) return false;
  }
  return index === shape.length;
}

export function createConversationEntityIndex(): ConversationEntityIndex {
  const producersCache = new WeakMap<object, { shape: unknown[]; value: ProducerEntry[] }>();
  const knownCache = new WeakMap<object, MessageContribution<KnownEntry[]>>();
  const seenCache = new WeakMap<object, MessageContribution<string[]>>();

  const producersOf = (messages: ReadonlyArray<ConversationMessage>) => mergeProducers(messages.map((message) => {
    const cached = producersCache.get(message);
    if (cached && sameShape(cached.shape, message)) return cached.value;
    const value = producersOfMessage(message);
    producersCache.set(message, { shape: shapeOf(message), value });
    return value;
  }));

  function contributions<T>(
    cache: WeakMap<object, MessageContribution<T>>,
    messages: ReadonlyArray<ConversationMessage>,
    searches: EntitySearches,
    declarations: EntityDeclarationsByTool | undefined,
    read: (message: ConversationMessage, byTool: SearchesByTool, producers: ResultProducers | undefined, reads: ReadDependency[]) => T,
  ): T[] {
    const producers = declarations ? producersOf(messages) : undefined;
    let byTool: SearchesByTool | undefined;
    return messages.map((message) => {
      const cached = cache.get(message);
      if (
        cached && cached.searches === searches && cached.declarations === declarations
        && cached.reads.every((dependency) => producers?.tools.get(dependency.id) === dependency.tool
          && producers?.outputs.get(dependency.id) === dependency.output)
        && sameShape(cached.shape, message)
      ) return cached.value;
      byTool ??= searchesByTool(searches);
      const reads: ReadDependency[] = [];
      const value = read(message, byTool, producers, reads);
      cache.set(message, { shape: shapeOf(message), searches, declarations, reads, value });
      return value;
    });
  }

  const mergeKnownEntries = createSettledMerge<KnownEntry[], ChatEntityReference>((entries) => entries, sameReference);
  const mergeSeenKeys = createSettledMerge<string[], string>((keys) => keys.map((key) => [key, key] as const), Object.is);
  let lastSeenList: ReadonlyArray<string> = [];
  let lastSeen: ReadonlySet<string> = new Set();

  return {
    known(messages, searches, declarations) {
      return mergeKnownEntries(contributions(knownCache, messages, searches, declarations,
        (message, byTool, producers, reads) => knownOfMessage(message, byTool, declarations, producers, reads)));
    },
    seen(messages, searches, declarations) {
      const list = mergeSeenKeys(contributions(seenCache, messages, searches, declarations,
        (message, byTool, producers, reads) => seenOfMessage(message, byTool, declarations, producers, reads)));
      if (list !== lastSeenList) {
        lastSeenList = list;
        if (list.length !== lastSeen.size || list.some((key) => !lastSeen.has(key))) lastSeen = new Set(list);
      }
      return lastSeen;
    },
  };
}

/**
 * Merges the contributions of the messages in order, the first value under a
 * key winning. The merge of the settled messages (all but the last) is kept
 * while their contributions are the same objects, so a streamed chunk merges
 * only what comes after them. A result equal to the last one is the same array.
 */
function createSettledMerge<T, V>(
  entriesOf: (contribution: T) => Iterable<readonly [string, V]>,
  same: (a: V, b: V) => boolean,
): (contributions: ReadonlyArray<T>) => V[] {
  interface Settled { readonly contributions: ReadonlyArray<T>; readonly found: ReadonlyMap<string, V>; readonly values: V[] }
  const empty: Settled = { contributions: [], found: new Map(), values: [] };
  let settled = empty;
  let lastSettled = settled;
  let lastTail: V[] = [];
  let last: V[] = [];
  return (contributions) => {
    const count = Math.max(0, contributions.length - 1);
    if (settled.contributions.length > count || settled.contributions.some((contribution, index) => contribution !== contributions[index])) {
      settled = empty;
    }
    if (settled.contributions.length < count) {
      const found = new Map(settled.found);
      const values = [...settled.values];
      for (const contribution of contributions.slice(settled.contributions.length, count)) {
        for (const [key, value] of entriesOf(contribution)) {
          if (found.has(key)) continue;
          found.set(key, value);
          values.push(value);
        }
      }
      settled = { contributions: contributions.slice(0, count), found, values };
    }
    const tail = new Map<string, V>();
    for (const contribution of contributions.slice(count)) {
      for (const [key, value] of entriesOf(contribution)) {
        if (!settled.found.has(key) && !tail.has(key)) tail.set(key, value);
      }
    }
    const tailValues = [...tail.values()];
    const tailSame = sameList(lastTail, tailValues, same);
    if (settled === lastSettled && tailSame) return last;
    const changedSettled = settled !== lastSettled;
    lastSettled = settled;
    lastTail = tailValues;
    const next = tailValues.length > 0 ? settled.values.concat(tailValues) : settled.values;
    // With the same settled merge a different tail is a different result; else compare it all (once per settled change).
    if (!changedSettled || !sameList(last, next, same)) last = next;
    return last;
  };
}

function sameList<V>(a: ReadonlyArray<V>, b: ReadonlyArray<V>, same: (a: V, b: V) => boolean): boolean {
  return a === b || (a.length === b.length && a.every((value, index) => same(value, b[index]!)));
}

function sameReference(a: ChatEntityReference, b: ChatEntityReference): boolean {
  return a === b || (a.type === b.type && a.id === b.id && a.label === b.label && sameData(a.data, b.data));
}

/** Whether two lists name the same references in the same order (type, id, label and equal `data`). */
export function sameReferences(a: ReadonlyArray<ChatEntityReference>, b: ReadonlyArray<ChatEntityReference>): boolean {
  return sameList(a, b, sameReference);
}

/**
 * Deep equality of plain data (objects, arrays, primitives); anything else
 * only by identity. Deeper than 32 levels (or a cycle) counts as different.
 */
function sameData(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth > 32) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((value, index) => sameData(value, b[index], depth + 1));
  }
  const plain = (value: object) => {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  if (Array.isArray(b) || !plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
    && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1));
}

/** Key of `collectSeenReferenceKeys`; the type compares case-insensitively. */
export function referenceKey(type: string, id: string): string {
  return `${type.toLowerCase()}\u0000${id}`;
}

/** Whether the conversation showed this reference (`collectSeenReferenceKeys`). */
export function isSeenReference(keys: ReadonlySet<string>, type: string, id: string): boolean {
  return keys.has(referenceKey(type, id)) || keys.has(referenceKey('', id));
}

/** The app path of an entity's `ui.navigate` action (`/tasks/:taskId`), or undefined. */
export function entityNavigationHref(entity: ChatEntityDefinition | undefined, id: string): string | undefined {
  for (const action of entity?.actions ?? []) {
    const destination = action.run.args?.destination;
    if (action.run.kind !== 'ui' || action.run.tool !== 'ui.navigate' || typeof destination !== 'string') continue;
    const name = action.entityArg.startsWith('params.') ? action.entityArg.slice('params.'.length) : action.entityArg;
    try {
      return buildNavigationHref({ destination, params: { [name]: id } });
    } catch {
      continue;
    }
  }
  return undefined;
}
