import type {
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  MentionResult,
} from '../types.js';
import { describeToolReference } from '../utils/mention-markup.js';

export interface CompletionSearchOptions {
  /** Passed to every provider; it only hides entries, the server authorizes. */
  context?: CompletionPermissionContext;
  /** Per-provider cap (default 8, max 20). */
  limitPerProvider?: number;
  /** Overall cap across providers (default 12, max 50). */
  maxResults?: number;
  /** A provider slower than this contributes nothing (default 3000 ms). */
  timeoutMs?: number;
  onProviderError?: (providerId: string, error: unknown) => void;
}

/** Narrows one search call. */
export interface CompletionSearchQueryOptions {
  /** Only these provider ids (of the trigger) are asked; omitted: all of them. */
  source?: string | ReadonlyArray<string>;
}

/** Compatible with `RichMentionInput`'s `onSearch`. */
export type CompletionSearch = (
  query: string,
  trigger: string,
  options?: CompletionSearchQueryOptions,
) => Promise<MentionResult[]>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isActions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((action) => (
    typeof action === 'object' && action !== null
    && typeof (action as Record<string, unknown>).id === 'string' && ACTION_ID.test((action as { id: string }).id)
    && typeof (action as Record<string, unknown>).label === 'string'
    && (action as { label: string }).label.trim().length > 0 && (action as { label: string }).label.length <= 200
  )));
}

function isItem(value: unknown): value is CompletionItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200
    && !/[:}]/.test(item.id)
    && typeof item.type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item.type)
    && typeof item.label === 'string' && item.label.trim().length > 0
    && (item.definitionId === undefined && item.args === undefined
      || describeToolReference(item.definitionId, item.args) !== undefined)
    && isActions(item.actions);
}

/** The pick fields that are valid; an invalid one is left out, so the item falls back to its default. */
function pickFields(item: CompletionItem): Pick<MentionResult, 'select' | 'insertText' | 'listSource'> {
  const { select, insertText, listSource } = item as { select?: unknown; insertText?: unknown; listSource?: unknown };
  return {
    ...(typeof select === 'string' && SELECT_KINDS.has(select) ? { select: select as CompletionItem['select'] } : {}),
    ...(typeof insertText === 'string' && insertText.trim().length > 0 ? { insertText } : {}),
    ...(listSource !== undefined && isListSource(listSource)
      ? { listSource: typeof listSource === 'string' ? listSource : [...(listSource as string[])] }
      : {}),
  };
}

const SELECT_KINDS = new Set<string>(['chip', 'text', 'run', 'list']);

function isListSource(value: unknown): boolean {
  if (value === undefined) return true;
  const ids = typeof value === 'string' ? [value] : value;
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && PROVIDER_ID.test(id));
}

function groupOf(value: unknown): { group?: string } {
  if (typeof value !== 'string') return {};
  const group = value.trim();
  return group && group.length <= 100 ? { group } : {};
}

/** Hits of one group stay together, groups in first-seen order. */
function grouped(results: MentionResult[]): MentionResult[] {
  if (!results.some((result) => result.group !== undefined)) return results;
  const groups = new Map<string, MentionResult[]>();
  for (const result of results) {
    const key = result.group ?? '';
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }
  return [...groups.values()].flat();
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Completion provider timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Merges the providers of a trigger (`@`, `/`, `#`, …) into one async search. Item ids stay the
 * app's ids (they reach the model through mention markers); `key` is the
 * stable list identity `providerId:type:itemId`. A newer search aborts the older
 * one, and a failing or slow provider never empties the others.
 */
export function createCompletionSearch(
  providers: ReadonlyArray<ChatCompletionProvider>,
  options: CompletionSearchOptions = {},
): CompletionSearch {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!PROVIDER_ID.test(provider.id)) {
      throw new Error(`Invalid completion provider id: ${provider.id}`);
    }
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate completion provider id: ${provider.id}`);
    }
    ids.add(provider.id);
  }
  const limit = clamp(options.limitPerProvider, 8, 20);
  const maxResults = clamp(options.maxResults, 12, 50);
  const timeoutMs = clamp(options.timeoutMs, 3_000, 30_000);
  const context = Object.freeze({ ...(options.context ?? {}) });
  let current: AbortController | null = null;

  return async (query, trigger, { source } = {}) => {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const sources = source === undefined ? undefined : new Set<string>(typeof source === 'string' ? [source] : source);
    const settled = await Promise.all(providers
      .filter((provider) => provider.trigger === trigger && (!sources || sources.has(provider.id)))
      .map(async (provider) => {
        try {
          const items = await withTimeout(Promise.resolve(provider.search({
            query, trigger, signal: controller.signal, context, limit,
          })), timeoutMs);
          return { provider, items: Array.isArray(items) ? items.slice(0, limit) : [] };
        } catch (error) {
          if (!controller.signal.aborted) options.onProviderError?.(provider.id, error);
          return { provider, items: [] };
        }
      }));
    if (controller.signal.aborted) return [];
    if (current === controller) current = null;

    const seen = new Set<string>();
    const results: MentionResult[] = [];
    collect: for (const { provider, items } of settled) {
      for (const item of items) {
        if (!isItem(item)) continue;
        const identity = `${item.type}:${item.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        results.push({
          id: item.id,
          key: `${provider.id}:${item.type}:${item.id}`,
          type: item.type,
          label: item.label.trim(),
          ...(item.description ? { description: item.description } : {}),
          ...(item.slug ? { slug: item.slug } : {}),
          ...(item.definitionId ? { definitionId: item.definitionId } : {}),
          ...(item.args ? { args: item.args } : {}),
          ...(item.actions?.length ? { actions: item.actions.map(({ id, label }) => ({ id, label: label.trim() })) } : {}),
          ...groupOf(item.group),
          ...pickFields(item),
        });
        if (results.length >= maxResults) break collect;
      }
    }
    return grouped(results);
  };
}
