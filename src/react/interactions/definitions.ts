import {
  parseChatInteractions,
  type ChatCommandRun,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatLocaleCode,
  type ChatText,
  type ChatToolRun,
} from '../../contracts/chat-interactions.js';
import type { CompletionPermissionContext } from '../types.js';

/** One search hit of an entity: the app's id and what the user sees. */
export interface ChatEntityItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Framework-neutral preview of an entity in the `@` list. */
export interface ChatEntityCard {
  readonly title: string;
  readonly subtitle?: string;
}

export interface ChatEntitySearchContext {
  /** Aborted when a newer search starts; pass it to `fetch`. */
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly locale: ChatLocaleCode;
  /** What the UI knows about the user; it only hides, the app authorizes. */
  readonly context: CompletionPermissionContext;
}

export interface ChatEntityAction {
  readonly id: string;
  readonly label: ChatText;
  /** Argument that receives the entity id (dotted path, e.g. `params.taskId`). */
  readonly entityArg: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatToolRun;
}

/**
 * An `@` entity: `search` runs in the browser with the user's session
 * against the app's own endpoints; nothing goes to the Glirastes Platform.
 */
export interface ChatEntityDefinition {
  readonly type: string;
  readonly label: ChatText;
  readonly icon?: string;
  search(query: string, context: ChatEntitySearchContext):
    | Promise<ReadonlyArray<ChatEntityItem>>
    | ReadonlyArray<ChatEntityItem>;
  /** Looks one entity up by id, e.g. to pre-fill the composer (`mentionEntity`). */
  resolve?(id: string): Promise<ChatEntityItem | undefined> | ChatEntityItem | undefined;
  card?(item: ChatEntityItem): ChatEntityCard;
  readonly actions?: ReadonlyArray<ChatEntityAction>;
}

/** A `/` command; `run` decides whether the model is involved (`prompt`) or not (`tool`, `ui`). */
export interface ChatCommandDefinition {
  readonly id: string;
  readonly label: ChatText;
  readonly description?: ChatText;
  readonly keywords?: ReadonlyArray<string>;
  readonly icon?: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatCommandRun;
}

const MAX_ITEM_TEXT = 200;

/** Validates and freezes an entity definition; throws on anything the chat could not use safely. */
export function defineChatEntity<T extends ChatEntityDefinition>(definition: T): T {
  if (typeof definition.search !== 'function') throw new Error(`Chat entity ${String(definition.type)} needs a search function`);
  const { search: _search, resolve: _resolve, card: _card, ...data } = definition;
  parseChatInteractions({ schemaVersion: 1, entities: [data], commands: [] });
  return Object.freeze(definition);
}

/** Validates and freezes a command definition. */
export function defineChatCommand<T extends ChatCommandDefinition>(definition: T): T {
  parseChatInteractions({ schemaVersion: 1, entities: [], commands: [definition] });
  return Object.freeze(definition);
}

/** Keeps only well-formed hits: a non-empty id and label, bounded text. */
export function toChatEntityItem(value: unknown): ChatEntityItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'number' && Number.isFinite(item.id) ? String(item.id) : item.id;
  if (typeof id !== 'string' || !id || id.length > MAX_ITEM_TEXT || /[:}]/.test(id)) return undefined;
  if (typeof item.label !== 'string' || !item.label.trim()) return undefined;
  const description = typeof item.description === 'string' && item.description.trim()
    ? item.description.trim().slice(0, MAX_ITEM_TEXT)
    : undefined;
  return { id, label: item.label.trim().slice(0, MAX_ITEM_TEXT), ...(description ? { description } : {}) };
}

export interface DerivedEntityOptions {
  /** Defaults to the global `fetch`; the request carries the user's cookies (same origin). */
  fetch?: typeof globalThis.fetch;
  /** Prefix for the app's endpoints, e.g. a separate API origin. Default: same origin. */
  baseUrl?: string;
}

function at(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Entity definitions for derived data: searches call the app endpoint with the user's session. */
export function entitiesFromData(
  data: ChatInteractionsData,
  options: DerivedEntityOptions = {},
): ChatEntityDefinition[] {
  return data.entities.map((entity) => {
    const search = entity.search;
    return {
      type: entity.type,
      label: entity.label,
      ...(entity.icon ? { icon: entity.icon } : {}),
      ...(entity.actions ? { actions: entity.actions } : {}),
      async search(query, context) {
        if (!search) return [];
        const params = new URLSearchParams({ [search.queryParam]: query });
        if (search.limitParam) params.set(search.limitParam, String(context.limit));
        const fetcher = options.fetch ?? globalThis.fetch;
        const response = await fetcher(`${options.baseUrl ?? ''}${search.path}?${params}`, {
          signal: context.signal,
          credentials: options.baseUrl ? 'include' : 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return [];
        const list = at(await response.json() as unknown, search.itemsPath);
        if (!Array.isArray(list)) return [];
        return list
          .map((item) => toChatEntityItem({
            id: at(item, [search.idField]),
            label: at(item, [search.labelField]),
            ...(search.descriptionField ? { description: at(item, [search.descriptionField]) } : {}),
          }))
          .filter((item): item is ChatEntityItem => item !== undefined)
          .slice(0, context.limit);
      },
    } satisfies ChatEntityDefinition;
  });
}
