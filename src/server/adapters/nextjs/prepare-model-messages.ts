/**
 * Utilities for preparing model messages and wrapping tools for Vercel AI SDK.
 *
 * - {@link prepareModelMessages} encapsulates the full pipeline:
 *   `convertToModelMessages` → `slice` → `pruneMessages` → `sanitizeModelMessages`
 *
 * - {@link wrapToolsForVercelAi} converts SDK tools (from `toolsToAiTools`) into
 *   Vercel AI SDK `tool()` instances ready for `streamText()`.
 *
 * @module
 */

import {
  convertToModelMessages,
  pruneMessages,
  type UIMessage,
} from 'ai';
import {
  createAiSdkTools,
  type AiSdkToolHooks,
} from '../../../runtime/ai-sdk/engine.js';
import { attachmentPlaceholderText } from '../../../contracts/attachments.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';
import { sanitizeModelMessages } from './sanitize-model-messages.js';
import { withModelFacingToolErrors } from './stream-error-text.js';
import {
  compactHistoryResult,
  compactToolOutput,
  HISTORY_DEFAULTS,
  HISTORY_TEXT_ONLY_NOTE,
} from './history-compaction.js';

export { compactToolOutput };

// ---------------------------------------------------------------------------
// prepareModelMessages
// ---------------------------------------------------------------------------

/** How earlier turns of the conversation are sent to the model. */
export interface HistoryOptions {
  /** Earlier turns sent at all (default 6). */
  maxTurns?: number;
  /** Most recent earlier turns that keep their tool calls, with compacted results (default 1). */
  toolTurns?: number;
  /** Estimated token budget of all earlier turns; the oldest drop first (default 4000). */
  maxTokens?: number;
  /** Array items kept complete per array in compacted tool results (default 10). */
  maxItems?: number;
  /** Characters kept per string in compacted tool results (default 300). */
  maxStringLength?: number;
  /**
   * Entries of a compacted result's dominant array beyond `maxItems` keep
   * their identity fields (`id`, `name`, …) instead of being dropped, under a
   * `_history` marker (default true). `false` drops them with a count.
   */
  keepIdentity?: boolean;
}

export interface PrepareModelMessagesOptions {
  /** Max model messages to keep (default: 12). The current turn is never split for earlier ones. */
  maxContextMessages?: number;
  /**
   * Turn-aware history (default on): the current turn complete, the previous
   * turn with compacted tool results, older turns as text. `false` keeps the
   * flat slice-and-prune of earlier versions.
   */
  history?: HistoryOptions | false;
  /**
   * Declared identity by model-facing tool name (`Tool.outputEntities`):
   * compacted results of a tool with a declaration keep exactly its declared
   * id and name fields. Without it, as before.
   */
  entities?: EntityDeclarationsByTool;
  /** Override pruneMessages config (legacy pipeline only). */
  pruneConfig?: {
    /** How to handle reasoning blocks (default: 'none'). */
    reasoning?: 'none' | 'keep';
    /** Tool-call pruning strategy (default: 'before-last-3-messages'). */
    toolCalls?: string;
    /** Empty message handling (default: 'remove'). */
    emptyMessages?: 'remove' | 'keep';
  };
}

const CHARS_PER_TOKEN = 4;
const MIN_TEXT_SHARE = 1_000;
/** Flat history estimate per file part; its encoded bytes say little about the model's cost. */
const FILE_PART_TOKENS = 1_000;

/**
 * Convert UI messages into sanitized model messages ready for `streamText()`.
 *
 * Pipeline:
 * 1. `convertToModelMessages` (with `ignoreIncompleteToolCalls: true`), the
 *    chat text of an invalid tool call replaced by an instruction for the model
 * 2. Turn-aware history (or the legacy slice + `pruneMessages`)
 * 3. `sanitizeModelMessages` — strip orphaned tool-calls for OpenAI compatibility
 * 4. Strip `uiAction` from tool results
 */
export async function prepareModelMessages(
  uiMessages: UIMessage[],
  options?: PrepareModelMessagesOptions,
): Promise<unknown[]> {
  const maxCtx = options?.maxContextMessages ?? 12;

  // A failed call keeps only the chat's text in the browser; the model gets an instruction instead.
  const raw = await convertToModelMessages(withModelFacingToolErrors(uiMessages), {
    ignoreIncompleteToolCalls: true,
  });

  const pruned = options?.history === false || options?.pruneConfig?.toolCalls
    ? pruneMessages({
        messages: raw.slice(-maxCtx),
        reasoning: (options?.pruneConfig?.reasoning ?? 'none') as 'none',
        toolCalls: (options?.pruneConfig?.toolCalls ??
          'before-last-3-messages') as 'before-last-3-messages',
        emptyMessages: (options?.pruneConfig?.emptyMessages ?? 'remove') as 'remove',
      })
    : pruneMessages({
        messages: turnAwareHistory(raw as ModelMessageLike[], maxCtx, {
          ...HISTORY_DEFAULTS,
          ...options?.history,
        }, options?.entities) as typeof raw,
        reasoning: 'none',
        toolCalls: 'none',
        emptyMessages: (options?.pruneConfig?.emptyMessages ?? 'remove') as 'remove',
      });

  const sanitized = sanitizeModelMessages(pruned);

  // Strip uiAction from tool-result parts — the LLM doesn't need them
  // (uiActions are auto-generated by SDK templates and consumed by the client)
  return stripUiActionsFromToolResults(sanitized);
}

interface ModelMessageLike {
  role: string;
  content: unknown;
}

function isFilePart(value: unknown): value is { type: 'file'; filename?: unknown } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'file' && 'data' in value;
}

/** Estimated size in characters: the JSON without file parts, plus a flat charge per file part. */
function estimateChars(messages: ReadonlyArray<unknown>): number {
  let files = 0;
  const json = JSON.stringify(messages, (_key, value: unknown) => {
    if (!isFilePart(value)) return value;
    files += 1;
    return undefined;
  });
  return json.length + files * FILE_PART_TOKENS * CHARS_PER_TOKEN;
}

function estimateTokens(messages: ReadonlyArray<unknown>): number {
  return Math.ceil(estimateChars(messages) / CHARS_PER_TOKEN);
}

function withoutFiles(message: ModelMessageLike): ModelMessageLike {
  if (!Array.isArray(message.content) || !message.content.some(isFilePart)) return message;
  return {
    ...message,
    content: (message.content as unknown[]).map((part) => (isFilePart(part)
      ? { type: 'text', text: attachmentPlaceholderText(typeof part.filename === 'string' ? part.filename : undefined) }
      : part)),
  };
}

/** Splits model messages into turns, each starting at a user message. */
function splitTurns(messages: ModelMessageLike[]): ModelMessageLike[][] {
  const turns: ModelMessageLike[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns;
}

function textOnly(turn: ModelMessageLike[]): ModelMessageLike[] {
  return turn
    .filter((message) => message.role !== 'tool')
    .map(withoutFiles)
    .map((message) => (message.role === 'assistant' && Array.isArray(message.content)
      ? {
          ...message,
          content: (message.content as Array<{ type?: unknown }>)
            .filter((part) => part.type === 'text'),
        }
      : message))
    .filter((message) => !Array.isArray(message.content) || message.content.length > 0);
}

/** Whether a turn holds tool calls or results, which `textOnly` leaves out. */
function hasToolContent(turn: ModelMessageLike[]): boolean {
  return turn.some((message) => message.role === 'tool' || (message.role === 'assistant'
    && Array.isArray(message.content)
    && (message.content as Array<{ type?: unknown }>).some((part) => part.type === 'tool-call')));
}

/** A text-only turn that says its tool results (and their ids) are left out. */
function withTextOnlyNote(turn: ModelMessageLike[]): ModelMessageLike[] {
  const note = { type: 'text', text: HISTORY_TEXT_ONLY_NOTE };
  const last = turn.length - 1;
  const message = turn[last];
  if (message?.role === 'assistant' && Array.isArray(message.content)) {
    return [...turn.slice(0, last), { ...message, content: [...message.content, note] }];
  }
  if (message?.role === 'assistant' && typeof message.content === 'string') {
    return [...turn.slice(0, last), { ...message, content: [{ type: 'text', text: message.content }, note] }];
  }
  return [...turn, { role: 'assistant', content: [note] }];
}

type CompactablePart = Record<string, unknown> & { output: { type: string; value: unknown } };

function isCompactable(part: Record<string, unknown>): part is CompactablePart {
  const output = part.output as { type?: unknown } | undefined;
  return part.type === 'tool-result' && !!output
    && (output.type === 'json' || output.type === 'text' || output.type === 'error-text' || output.type === 'error-json');
}

/**
 * The turn without reasoning, its tool results compacted. When the turn
 * does not fit `maxTokens` so, the results share what its other content
 * leaves (a result smaller than its share keeps its size, the rest is split
 * evenly) and each is compacted within its share.
 */
/**
 * The tool that produced each result handle (`_result.id`) and the input of
 * each `read_result` call, over all given messages: a `read_result` answer is
 * compacted with the declarations of the tool whose handle it read, also when
 * the handle came from an earlier turn of a store that keeps it longer.
 */
interface HandleProducers {
  producers: Map<string, string>;
  readInputs: Map<string, unknown>;
}

function handleProducersOf(messages: ReadonlyArray<ModelMessageLike>): HandleProducers {
  const producers = new Map<string, string>();
  const readInputs = new Map<string, unknown>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-call' && part.toolName === READ_RESULT_TOOL_NAME && typeof part.toolCallId === 'string') {
        readInputs.set(part.toolCallId, part.input);
      }
      const value = part.type === 'tool-result' ? (part.output as { value?: unknown } | undefined)?.value : undefined;
      const marker = typeof value === 'object' && value !== null ? (value as { _result?: unknown })._result : undefined;
      const id = typeof marker === 'object' && marker !== null ? (marker as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && typeof part.toolName === 'string' && part.toolName !== READ_RESULT_TOOL_NAME) producers.set(id, part.toolName);
    }
  }
  return { producers, readInputs };
}

function withCompactedResults(
  turn: ModelMessageLike[],
  limits: Required<HistoryOptions>,
  entities?: EntityDeclarationsByTool,
  handles: HandleProducers = handleProducersOf(turn),
): ModelMessageLike[] {
  const withResults = (compact: (value: unknown, index: number, part: CompactablePart) => unknown): ModelMessageLike[] => {
    let index = 0;
    return turn.map((message) => {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        return {
          ...message,
          content: (message.content as Array<{ type?: unknown }>)
            .filter((part) => part.type !== 'reasoning'),
        };
      }
      if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: (message.content as Array<Record<string, unknown>>).map((part) => (isCompactable(part)
          ? { ...part, output: { ...part.output, value: compact(part.output.value, index++, part) } }
          : part)),
      };
    });
  };
  const options = { maxItems: limits.maxItems, maxStringLength: limits.maxStringLength, keepIdentity: limits.keepIdentity };
  // A `read_result` answer is compacted with the declarations of the tool that produced its handle.
  const { producers, readInputs } = handles;
  const producerOf = (part: CompactablePart): unknown => {
    if (part.toolName !== READ_RESULT_TOOL_NAME || typeof part.toolCallId !== 'string') return part.toolName;
    const input = readInputs.get(part.toolCallId);
    const resultId = typeof input === 'object' && input !== null ? (input as { resultId?: unknown }).resultId : undefined;
    return (typeof resultId === 'string' && producers.get(resultId)) || part.toolName;
  };
  /** The options for one part: with its tool's declared entities, when it has any. */
  const optionsOf = (part: CompactablePart) => {
    const tool = entities ? producerOf(part) : undefined;
    const declared = typeof tool === 'string' && entities && Object.prototype.hasOwnProperty.call(entities, tool)
      ? entities[tool]!.output
      : undefined;
    return declared ? { ...options, entities: declared } : options;
  };
  const compacted: unknown[] = [];
  const first = withResults((value, _index, part) => {
    const result = compactHistoryResult(value, optionsOf(part));
    compacted.push(result);
    return result;
  });
  const room = limits.maxTokens * CHARS_PER_TOKEN;
  if (compacted.length === 0 || estimateChars(first) <= room) return first;

  // Each result within its share of what the rest of the turn leaves (`null` in its place).
  let left = room - estimateChars(withResults(() => null));
  const sizes = compacted.map((result) => (JSON.stringify(result)?.length ?? 4) - 4);
  const shares: Array<number | undefined> = sizes.map(() => undefined);
  let open = sizes.map((_, index) => index);
  for (;;) {
    const share = Math.floor(left / Math.max(1, open.length));
    const small = open.filter((index) => sizes[index]! <= share);
    if (small.length === 0) {
      for (const index of open) shares[index] = Math.max(0, share);
      break;
    }
    for (const index of small) left -= sizes[index]!;
    open = open.filter((index) => sizes[index]! > share);
  }
  return withResults((value, index, part) => (shares[index] === undefined
    ? compacted[index]
    : compactHistoryResult(value, { ...optionsOf(part), maxChars: shares[index]! + 4 })));
}

/** Cuts text longer than its share of `maxChars` to head and tail. */
function withTruncatedTexts(turn: ModelMessageLike[], maxChars: number): ModelMessageLike[] {
  const texts = turn.flatMap((message) => (typeof message.content === 'string'
    ? [message.content]
    : Array.isArray(message.content)
      ? (message.content as Array<{ type?: unknown; text?: unknown }>)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
      : []));
  const share = Math.max(MIN_TEXT_SHARE, Math.floor(maxChars / Math.max(1, texts.length)));
  const cut = (text: string) => {
    if (text.length <= share) return text;
    const head = Math.floor(share * 0.7);
    const tail = share - head;
    return `${text.slice(0, head)}\n[… ${text.length - share} characters omitted …]\n${text.slice(-tail)}`;
  };
  return turn.map((message) => (typeof message.content === 'string'
    ? { ...message, content: cut(message.content) }
    : Array.isArray(message.content)
      ? {
          ...message,
          content: (message.content as Array<{ type?: unknown; text?: unknown }>).map((part) =>
            (part.type === 'text' && typeof part.text === 'string' ? { ...part, text: cut(part.text) } : part)),
        }
      : message));
}

/**
 * The current turn stays complete. The previous turn is always sent: with
 * compacted tool results, as text when that does not fit, oversized text cut
 * to head and tail. Older turns go as text, at most `maxTurns`, within what
 * `maxTokens` and `maxCtx` leave. The newest text-only turn whose tool
 * results were left out ends with a note that no ids from them are known.
 */
function turnAwareHistory(
  messages: ModelMessageLike[],
  maxCtx: number,
  limits: Required<HistoryOptions>,
  entities?: EntityDeclarationsByTool,
): ModelMessageLike[] {
  const handles = entities ? handleProducersOf(messages) : undefined;
  const turns = splitTurns(messages);
  const current = turns.pop() ?? [];
  const kept = turns.slice(-Math.max(0, limits.maxTurns));
  const isToolTurn = (index: number) => index >= kept.length - limits.toolTurns;
  const earlier = kept.map((turn, index) => (isToolTurn(index) ? withCompactedResults(turn, limits, entities, handles) : textOnly(turn)));
  // Per earlier turn: sent as text with its tool calls and results left out.
  const dropped = kept.map((turn, index) => !isToolTurn(index) && hasToolContent(turn));
  const previousSource = kept.at(-1);
  let previousDropped = dropped.pop() ?? false;
  let previous = earlier.pop();
  if (!previous || !previousSource) return current;

  const tooLarge = (turn: ModelMessageLike[]) =>
    estimateTokens(turn) > limits.maxTokens || turn.length + current.length > maxCtx;
  if (tooLarge(previous)) {
    previous = textOnly(previous);
    previousDropped = hasToolContent(previousSource);
  }
  // The newest turn whose tool results were left out says so, once.
  if (previousDropped) previous = withTextOnlyNote(previous);
  if (estimateTokens(previous) > limits.maxTokens) {
    previous = withTruncatedTexts(previous, limits.maxTokens * CHARS_PER_TOKEN);
  }

  const tokenRoom = limits.maxTokens - estimateTokens(previous);
  const messageRoom = maxCtx - current.length - previous.length;
  const sent = () => {
    const newest = previousDropped ? -1 : dropped.lastIndexOf(true);
    return earlier.flatMap((turn, index) => (index === newest ? withTextOnlyNote(turn) : turn));
  };
  while (
    earlier.length > 0
    && (estimateTokens(sent()) > tokenRoom || sent().length > messageRoom)
  ) {
    earlier.shift();
    dropped.shift();
  }
  return [...sent(), ...previous, ...current];
}

// ---------------------------------------------------------------------------
// stripUiActionsFromToolResults
// ---------------------------------------------------------------------------

/**
 * Remove `uiAction` fields from tool-result parts in model messages.
 *
 * UI actions are auto-generated by SDK templates (uiActionOnSuccess, uiPattern)
 * and consumed by the client for toasts, navigation, and refreshes. The LLM
 * doesn't generate or use them — keeping them wastes 100-500 tokens per call.
 *
 * This runs AFTER sanitization so it doesn't interfere with orphan detection.
 */
function stripUiActionsFromToolResults<T>(messages: T[]): T[] {
  return messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role !== 'tool' || !Array.isArray(m.content)) return msg;

    const newContent = (m.content as Record<string, unknown>[]).map((part) => {
      if (part.type !== 'tool-result') return part;
      // AI SDK 5+ wraps the result as `output: { type: 'json', value }`.
      const output = part.output as { type?: unknown; value?: unknown } | undefined;
      if (output?.type === 'json' && isPlainObject(output.value) && 'uiAction' in output.value) {
        const { uiAction: _stripped, ...rest } = output.value;
        return { ...part, output: { ...output, value: rest } };
      }
      if (!isPlainObject(part.result) || !('uiAction' in part.result)) return part;
      const { uiAction: _stripped, ...rest } = part.result;
      return { ...part, result: rest };
    });

    return { ...m, content: newContent } as T;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// wrapToolsForVercelAi
// ---------------------------------------------------------------------------

interface SdkAiTool {
  description: string;
  parameters: unknown;
  needsApproval?: unknown;
  execute: (...args: unknown[]) => unknown;
}

/**
 * Convert SDK AI tools (output of `toolsToAiTools`) into Vercel AI SDK
 * `tool()` instances.
 *
 * @example
 * ```ts
 * import { wrapToolsForVercelAi } from './index.js';
 *
 * const vercelTools = wrapToolsForVercelAi(ctx.tools);
 * const result = streamText({ tools: vercelTools, ... });
 * ```
 */
export function wrapToolsForVercelAi(
  sdkTools: Record<string, unknown>,
  hooks?: AiSdkToolHooks,
): Record<string, unknown> {
  return createAiSdkTools({
    tools: sdkTools as Record<string, SdkAiTool>,
    ...hooks,
  });
}
