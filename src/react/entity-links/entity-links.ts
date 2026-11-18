import { buildNavigationHref } from '../../browser/navigation.js';
import type { ChatEntitySearchData } from '../../contracts/chat-interactions.js';
import type { ChatEntityDefinition } from '../interactions/definitions.js';
import { parseMentionSegments } from '../utils/mention-markup.js';
import {
  declaredRecordsOf,
  entityIdText,
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
   * `first` (default) links the first one found, `text` leaves the name as
   * text. `resolveAmbiguous` decides instead when given.
   */
  readonly ambiguousNames?: 'first' | 'text';
  /** Picks the reference for a name several known references share; `undefined` leaves it as text. */
  resolveAmbiguous?(label: string, candidates: ReadonlyArray<ChatEntityReference>): ChatEntityReference | undefined;
  /** `all` (default) links in every message, `assistant` only in the assistant's text. */
  readonly scope?: 'all' | 'assistant';
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
  const decide = options.resolveAmbiguous !== undefined || options.ambiguousNames === 'text';
  const candidates = new Map<string, ChatEntityReference[]>();
  for (const reference of options.known ?? []) {
    const label = reference.label.trim();
    if (label.length < minLength) continue;
    if (!decide) {
      if (!byLabel.has(label)) byLabel.set(label, reference);
      continue;
    }
    const list = candidates.get(label) ?? [];
    if (!list.some((known) => known.type === reference.type && known.id === reference.id)) list.push(reference);
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
  const add = (reference: ChatEntityReference) => {
    const key = `${reference.type}\u0000${reference.id}`;
    if (!found.has(key)) found.set(key, reference);
  };
  const byTool = new Map(searches.map((entry) => [toolKey(entry.search.tool), entry]));
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
      const declared = result && declarations && Object.prototype.hasOwnProperty.call(declarations, result.tool)
        ? declarations[result.tool]!.output
        : undefined;
      if (result && declared) {
        for (const identity of declaredRecordsOf(result.output, declared).values()) {
          if (identity.declaration.type && identity.name) {
            add({ type: identity.declaration.type, id: entityIdText(identity.idValues), label: identity.name });
          }
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
