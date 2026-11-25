/**
 * Frozen copy of `entity-links.ts` as released in 0.29.0: the oracle of the
 * differential test (`entity-links-index.test.ts`). Do not change it with the
 * implementation; it is what the implementation must keep producing.
 */
import { buildNavigationHref } from '../../../browser/navigation.js';
import type { ChatEntitySearchData } from '../../../contracts/chat-interactions.js';
import type { ChatEntityDefinition } from '../../interactions/definitions.js';
import { parseMentionSegments } from '../../utils/mention-markup.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';
import {
  declarationsForRead,
  declaredRecordsOf,
  entityIdText,
  entityLookupId,
  type DeclaredRecordIdentity,
  type EntityDeclarationsByTool,
} from '../../../contracts/entity-declaration.js';

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

function boundaryPattern(source: string, flags: string): RegExp {
  const extra = [...new Set(flags.replace(/[gyu]/g, ''))].join('');
  return new RegExp(`(?<!${WORD})(?:${source})(?!${WORD})`, `gu${extra}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits text into plain parts, matcher hits and known entity names. The
 * earliest match wins; at the same position the longer one.
 */
export function splitEntityText(
  text: string,
  options: {
    readonly matchers?: ReadonlyArray<Pick<ChatEntityMatcher, 'type' | 'pattern'>>;
    readonly known?: ReadonlyArray<ChatEntityReference>;
    readonly minLabelLength?: number;
    readonly ambiguousNames?: 'first' | 'text';
    readonly resolveAmbiguous?: (label: string, candidates: ReadonlyArray<ChatEntityReference>) => ChatEntityReference | undefined;
  } = {},
): ChatEntityTextSegment[] {
  const minLength = options.minLabelLength ?? 4;
  const byLabel = new Map<string, ChatEntityReference>();
  // Since 0.18.0 a name several records share stays text unless `ambiguousNames: 'first'` (the behaviour before).
  const decide = options.resolveAmbiguous !== undefined || options.ambiguousNames !== 'first';
  const candidates = new Map<string, ChatEntityReference[]>();
  for (const reference of options.known ?? []) {
    const label = reference.label.trim();
    if (label.length < minLength) continue;
    if (!decide) {
      if (!byLabel.has(label)) byLabel.set(label, reference);
      continue;
    }
    const list = candidates.get(label) ?? [];
    const same = (known: ChatEntityReference) => known.type === reference.type && known.id === reference.id
      && JSON.stringify(known.data?.idValues) === JSON.stringify(reference.data?.idValues);
    if (!list.some(same)) list.push(reference);
    candidates.set(label, list);
  }
  for (const [label, list] of candidates) {
    if (list.length === 1) {
      byLabel.set(label, list[0]!);
      continue;
    }
    const picked = options.resolveAmbiguous?.(label, list);
    if (picked) byLabel.set(label, picked);
  }
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  const patterns: Array<{ regex: RegExp; matcher?: number }> = (options.matchers ?? []).map((matcher, index) => ({
    regex: boundaryPattern(matcher.pattern.source, matcher.pattern.flags),
    matcher: index,
  }));
  if (labels.length > 0) patterns.push({ regex: boundaryPattern(labels.join('|'), '') });
  const trailingLabel = labels.length > 0
    ? new RegExp(`[ \\t]*(?:[:\u2013\u2014-][ \\t]*)?(?:${labels.join('|')})(?!${WORD})`, 'uy')
    : undefined;
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

/**
 * Entities a conversation already names: `{{mention:type:id:label}}` markers
 * in any message and the items of an entity search tool's results.
 */
export function collectKnownEntities(
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<unknown> }>,
  searches: ReadonlyArray<{ readonly type: string; readonly search: ChatEntitySearchData }> = [],
  declarations?: EntityDeclarationsByTool,
): ChatEntityReference[] {
  const found = new Map<string, ChatEntityReference>();
  const add = (reference: ChatEntityReference, lookup?: string) => {
    const key = `${reference.type}\u0000${lookup ?? reference.id}`;
    if (!found.has(key)) found.set(key, reference);
  };
  const byTool = new Map(searches.map((entry) => [toolKey(entry.search.tool), entry]));
  const producers = declarations ? resultProducers(messages) : undefined;
  for (const message of messages) {
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
      for (const identity of result && producers ? declaredIdentitiesOf(part, result, declarations!, producers) : []) {
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
  }
  return [...found.values()];
}

/** A `read_result` answer belongs to the tool that produced the result it reads. */
interface ResultProducers {
  tools: Map<string, string>;
  outputs: Map<string, unknown>;
}

function resultProducers(messages: ReadonlyArray<{ readonly parts: ReadonlyArray<unknown> }>): ResultProducers {
  const tools = new Map<string, string>();
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    for (const part of message.parts) {
      const result = toolOutputOf(part);
      const marker = result && isRecord(result.output) ? result.output._result : undefined;
      if (result && result.tool !== READ_RESULT_TOOL_NAME && isRecord(marker) && typeof marker.id === 'string') {
        tools.set(marker.id, result.tool);
        outputs.set(marker.id, result.output);
      }
    }
  }
  return { tools, outputs };
}

/** The records of one tool result its tool's `outputEntities` declare (a read: the producing tool's). */
function declaredIdentitiesOf(
  part: unknown,
  result: { tool: string; output: unknown },
  declarations: EntityDeclarationsByTool,
  producers: ResultProducers,
): Iterable<DeclaredRecordIdentity> {
  const readId = result.tool === READ_RESULT_TOOL_NAME && isRecord(part) && isRecord(part.input)
    && typeof part.input.resultId === 'string' ? part.input.resultId : undefined;
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
  messages: ReadonlyArray<{ readonly role?: string; readonly parts: ReadonlyArray<unknown> }>,
  searches: ReadonlyArray<{ readonly type: string; readonly search: ChatEntitySearchData }> = [],
  declarations?: EntityDeclarationsByTool,
): Set<string> {
  const keys = new Set<string>();
  const byTool = new Map(searches.map((entry) => [toolKey(entry.search.tool), entry]));
  const producers = declarations ? resultProducers(messages) : undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        if (message.role !== 'user') continue;
        for (const segment of parseMentionSegments(part.text)) {
          if (segment.kind === 'mention' && segment.mention.type !== 'command') keys.add(referenceKey(segment.mention.type, segment.mention.id));
        }
        continue;
      }
      const result = toolOutputOf(part);
      if (!result) continue;
      for (const identity of producers ? declaredIdentitiesOf(part, result, declarations!, producers) : []) {
        keys.add(referenceKey(identity.declaration.type ?? '', entityIdText(identity.idValues)));
      }
      const entry = byTool.get(toolKey(result.tool));
      if (!entry) continue;
      for (const candidate of [result.output, at(result.output, ['data']), at(result.output, ['value'])]) {
        const list = entry.search.itemsPath.length ? at(candidate, entry.search.itemsPath) : candidate;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const id = at(item, [entry.search.idField]);
          if (typeof id === 'string' || typeof id === 'number') keys.add(referenceKey(entry.type, String(id)));
        }
        break;
      }
    }
  }
  return keys;
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
