/**
 * Chat Views in the chat handler (optional, `AiChatHandlerConfig.chatViews`):
 * the `render_view` built-in, the lookup of the tool results a view may
 * reference, and the model-input side (no projection ever reaches the model,
 * a content-free source memo of what is referenceable).
 *
 * Values in a view are never rehydrated: they come from tool results that
 * already passed the PII shield (the tool parts the browser holds, or the
 * sealed copy in the turn's result store) and stay in that form.
 */
import {
  CHAT_VIEW_LIMITS,
  RENDER_VIEW_TOOL_NAME,
  chatComponentManifestSchema,
  chatViewCapabilitiesSchema,
  chatViewSpecSchema,
  type ChatComponentManifest,
  type ChatViewCapabilities,
} from '../../../contracts/chat-view.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';
import {
  describeChatCatalog,
  effectiveChatManifest,
  mergeChatManifests,
  resolveChatView,
  starterChatComponentManifest,
  toChatComponentManifest,
  validateChatViewSpec,
  type ChatComponentDefinition,
  type ChatViewSourceLookup,
} from '../../../chat-views/index.js';
import { defineTool, type Tool } from '../../../types.js';
import { MAX_MAX_RESULT_CHARS } from '../../../runtime/result-limit.js';
import { withToolModelOutput } from '../../core/tool-model-output.js';
import { echoableKey } from '../../core/read-result-tool.js';
import type { ResultStore } from '../../core/index.js';
import type { TurnResults } from './result-handles.js';
import { NON_DOMAIN_TOOL_NAMES } from './tool-discovery.js';

/** `AiChatHandlerConfig.chatViews`. */
export interface ChatViewsConfig {
  /**
   * The app's components, as a manifest or as `defineChatComponent`
   * definitions. Merged over the SDK starter catalog (an entry with the same
   * id and schema version replaces the starter's). Without it the starter
   * catalog alone.
   */
  catalog?: ChatComponentManifest | ChatComponentDefinition[];
  /** Views per answer; only `1` in this release. */
  maxViewsPerTurn?: 1;
}

/** The answer when the model tries a second view in one answer. */
export const ONE_VIEW_PER_ANSWER = 'one view per answer';

const CONFIG_KEYS: ReadonlySet<string> = new Set(['catalog', 'maxViewsPerTurn']);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasOwn = (value: Json, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The manifest of `chatViews` (the app's catalog merged over the starter
 * catalog), or null when the feature is off. Throws for an invalid value.
 */
export function resolveChatViews(value: unknown, label: string): ChatComponentManifest | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${label}: chatViews must be an object ({ catalog?, maxViewsPerTurn? })`);
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`${label}: chatViews.${key} is not an option`);
  }
  if (value.maxViewsPerTurn !== undefined && value.maxViewsPerTurn !== 1) {
    throw new Error(`${label}: chatViews.maxViewsPerTurn must be 1`);
  }
  const catalog = value.catalog;
  if (catalog === undefined) return starterChatComponentManifest;
  let app: ChatComponentManifest;
  if (Array.isArray(catalog)) {
    try {
      app = toChatComponentManifest(catalog as ChatComponentDefinition[]);
    } catch (error) {
      throw new Error(`${label}: chatViews.catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const parsed = chatComponentManifestSchema.safeParse(catalog);
    if (!parsed.success) {
      throw new Error(`${label}: chatViews.catalog must be a chat component manifest (v: 1) or a list of defineChatComponent definitions`);
    }
    app = parsed.data;
  }
  return mergeChatManifests(starterChatComponentManifest, app);
}

/** The request's `chatViews` field; undefined when absent or invalid (then nothing is narrowed). */
export function readChatViewCapabilities(body: unknown): ChatViewCapabilities | undefined {
  if (!isRecord(body) || body.chatViews === undefined) return undefined;
  const parsed = chatViewCapabilitiesSchema.safeParse(body.chatViews);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Tool parts of UI messages
// ---------------------------------------------------------------------------

interface ToolPart {
  toolCallId: string;
  toolName: string;
  state: unknown;
  output: unknown;
}

function toolPartOf(part: unknown): ToolPart | undefined {
  if (!isRecord(part) || typeof part.type !== 'string' || typeof part.toolCallId !== 'string') return undefined;
  const toolName = part.type === 'dynamic-tool'
    ? part.toolName
    : part.type.startsWith('tool-') ? part.type.slice(5) : undefined;
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined;
  return { toolCallId: part.toolCallId, toolName, state: part.state, output: part.output };
}

function partsOf(message: unknown): unknown[] {
  return isRecord(message) && Array.isArray(message.parts) ? message.parts : [];
}

function lastUserIndex(messages: ReadonlyArray<unknown>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRecord(messages[index]) && (messages[index] as Json).role === 'user') return index;
  }
  return -1;
}

/** A tool output a view may use: present and not a failure. */
function isSuccessfulOutput(output: unknown): boolean {
  if (output === undefined || output === null) return false;
  if (!isRecord(output)) return true;
  if (output.success === false) return false;
  // The error answer of a thrown tool (`{ error: "Error in …", hint }`).
  return !(typeof output.error === 'string' && !hasOwn(output, 'success'));
}

/**
 * A cut (`_truncated`) or overview (`_result`) form of a result. A
 * `read_result` answer always carries `_result` (its paging): it is partial
 * only when cut or when further entries follow (`nextOffset`).
 */
function isCutOutput(toolName: string, output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (hasOwn(output, '_truncated')) return true;
  if (!hasOwn(output, '_result')) return false;
  if (toolName !== READ_RESULT_TOOL_NAME) return true;
  return !isRecord(output._result) || output._result.nextOffset !== undefined;
}

/** Whether a tool's results may be referenced: domain tools and `read_result`, no other SDK built-in. */
function isReferenceableTool(toolName: string): boolean {
  return toolName === READ_RESULT_TOOL_NAME || !(NON_DOMAIN_TOOL_NAMES as ReadonlyArray<string>).includes(toolName);
}

// ---------------------------------------------------------------------------
// Current-turn outputs and the source lookup
// ---------------------------------------------------------------------------

/** The output of one tool call of this request, as the tool part holds it. */
interface ToolOutputRecord {
  toolName: string;
  output: unknown;
  /** The result handle when the output is an overview the store issued (full value in the store). */
  handleId?: string;
}

function handleIdOf(toolName: string, output: unknown, store: ResultStore | undefined): string | undefined {
  if (!store || toolName === READ_RESULT_TOOL_NAME || !store.isIssued(output) || !isRecord(output)) return undefined;
  const marker = hasOwn(output, '_result') ? output._result : undefined;
  const id = isRecord(marker) ? marker.id : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Wraps each tool's `execute` so the output of every call is recorded by its
 * tool call id (the AI SDK's execution options). Applied to the request's AI
 * tools after the PII shield: the record holds what the tool part holds.
 */
function recordToolOutputs<T extends Record<string, unknown>>(
  tools: T,
  records: Map<string, ToolOutputRecord>,
  store: ResultStore | undefined,
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(tools)) {
    const tool = raw as { execute?: (...args: unknown[]) => unknown };
    if (typeof tool?.execute !== 'function') {
      wrapped[name] = raw;
      continue;
    }
    const execute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        const output = await execute(...args);
        const toolCallId = isRecord(args[1]) ? args[1].toolCallId : undefined;
        if (typeof toolCallId === 'string') {
          const handleId = handleIdOf(name, output, store);
          records.set(toolCallId, { toolName: name, output, ...(handleId ? { handleId } : {}) });
        }
        return output;
      },
    };
  }
  return wrapped as T;
}

/**
 * Finds a referenced tool result: a call of this request first (the full
 * value from the store when the model saw an overview, read with the guard
 * of `read_result`), else a tool part of the request's history.
 */
function createSourceLookup(options: {
  records: ReadonlyMap<string, ToolOutputRecord>;
  history: () => ReadonlyArray<unknown>;
  readStored?: TurnResults['readStored'];
}): ChatViewSourceLookup {
  return async (toolCallId) => {
    const current = options.records.get(toolCallId);
    if (current) {
      if (!isReferenceableTool(current.toolName) || !isSuccessfulOutput(current.output)) return undefined;
      if (current.handleId && options.readStored) {
        const read = await options.readStored(current.handleId);
        if (read.status === 'ok') return { toolName: current.toolName, value: read.value, truncated: false };
        // Another principal or a spent budget: nothing of the result (fail closed).
        if (read.status !== 'missing') return undefined;
      }
      return { toolName: current.toolName, value: current.output, truncated: isCutOutput(current.toolName, current.output) };
    }
    for (const message of options.history()) {
      for (const raw of partsOf(message)) {
        const part = toolPartOf(raw);
        if (!part || part.toolCallId !== toolCallId) continue;
        if (part.state !== 'output-available' || !isReferenceableTool(part.toolName) || !isSuccessfulOutput(part.output)) {
          return undefined;
        }
        return { toolName: part.toolName, value: part.output, truncated: isCutOutput(part.toolName, part.output) };
      }
    }
    return undefined;
  };
}

/** The call ids a spec references (`$ref`), in document order. */
function referencedCallIds(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) referencedCallIds(item, into);
  } else if (isRecord(value)) {
    if (typeof value.$ref === 'string') into.push(value.$ref);
    for (const child of Object.values(value)) referencedCallIds(child, into);
  }
  return into;
}

/** Views the current turn already showed (an approval or UI outcome continues the turn in a new request). */
function viewsShownInTurn(messages: ReadonlyArray<unknown>): number {
  let count = 0;
  for (const message of messages.slice(lastUserIndex(messages) + 1)) {
    for (const raw of partsOf(message)) {
      const part = toolPartOf(raw);
      if (part?.toolName === RENDER_VIEW_TOOL_NAME && part.state === 'output-available'
        && isRecord(part.output) && part.output.shown === true) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** The model's view of a `render_view` result: never the resolved `view`. */
export function renderViewModelOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (output.shown === true) return { shown: true, elements: output.elements };
  const { view: _view, ...rest } = output;
  return rest;
}

export interface CreateRenderViewToolOptions {
  /** The handler's manifest; the tool offers its intersection with `capabilities`. */
  manifest: ChatComponentManifest;
  /** What the client can render (request body `chatViews`); only narrows. */
  capabilities?: ChatViewCapabilities;
  lookup: ChatViewSourceLookup;
  /** Views the turn showed before this request (default 0). */
  viewsBefore?: () => number;
  /** Called with every successful output before it is returned (marks it as issued). */
  onShown?: (output: Json) => void;
  /**
   * Run when the AI SDK asks whether a call needs approval (it never does):
   * a throw ends the turn like a domain tool's guard (managed turns).
   */
  precheck?: (input: unknown) => Promise<void>;
}

/**
 * The `render_view` tool: validates the model's spec against the effective
 * catalog, resolves its references and answers `{ shown: true, elements,
 * view }`; the model gets only `{ shown, elements }` (`toModelOutput`).
 * One view per answer.
 */
export function createRenderViewTool(options: CreateRenderViewToolOptions): Tool {
  const manifest = effectiveChatManifest(options.manifest, options.capabilities);
  const surface = options.capabilities?.surface;
  let shown = 0;
  let running = 0;
  const fail = (errors: string[]) => ({ success: false, error: errors.join('\n') });
  const tool = defineTool({
    id: RENDER_VIEW_TOOL_NAME,
    description: describeChatCatalog(manifest),
    inputSchema: chatViewSpecSchema,
    // A view is bounded by CHAT_VIEW_LIMITS.maxProjectionBytes, never cut by the result limit.
    maxResultChars: MAX_MAX_RESULT_CHARS,
    ...(options.precheck
      ? {
          needsApproval: async (input: unknown) => {
            await options.precheck!(input);
            return false;
          },
        }
      : {}),
    execute: async (input: unknown): Promise<Json> => {
      if ((options.viewsBefore?.() ?? 0) + shown + running >= 1) return { success: false, error: ONE_VIEW_PER_ANSWER };
      running += 1;
      try {
        const validated = validateChatViewSpec(input, manifest, surface ? { surface } : {});
        if (!validated.ok) return fail(validated.errors);
        const resolved = await resolveChatView(validated.spec, manifest, options.lookup);
        if (!resolved.ok) return fail(resolved.errors);
        shown += 1;
        const output = { shown: true, elements: Object.keys(resolved.view.elements).length, view: resolved.view };
        options.onShown?.(output);
        return output;
      } finally {
        running -= 1;
      }
    },
  });
  return withToolModelOutput(tool, renderViewModelOutput);
}

/** Chat Views of one model request: the tool and its bookkeeping. */
export interface ChatViewTurn {
  tool: Tool;
  /** Records every call's output (wrap the request's AI tools after the PII shield). */
  recordOutputs<T extends Record<string, unknown>>(tools: T): T;
}

/**
 * Creates the `render_view` tool of one request. `history` returns the
 * request's messages (earlier-turn references); `results` is the turn's
 * result store, when result handles are on.
 */
export function beginChatViewTurn(options: {
  manifest: ChatComponentManifest;
  capabilities?: ChatViewCapabilities;
  history: () => ReadonlyArray<unknown>;
  results?: TurnResults;
}): ChatViewTurn {
  const records = new Map<string, ToolOutputRecord>();
  const store = options.results?.store;
  const tool = createRenderViewTool({
    manifest: options.manifest,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    lookup: createSourceLookup({
      records,
      history: options.history,
      ...(options.results ? { readStored: options.results.readStored } : {}),
    }),
    viewsBefore: () => viewsShownInTurn(options.history()),
    // Built from values that already passed the shield: never sealed again.
    ...(store ? { onShown: (output: Json) => store.markIssued(output) } : {}),
    // Like read_result: the origin tool's guard runs before the call, for every stored source it reads.
    ...(options.results?.precheckStored
      ? {
          precheck: async (input: unknown) => {
            for (const id of new Set(referencedCallIds(input))) {
              const handleId = records.get(id)?.handleId;
              if (handleId) await options.results!.precheckStored!(handleId);
            }
          },
        }
      : {}),
  });
  return { tool, recordOutputs: (tools) => recordToolOutputs(tools, records, store) };
}

// ---------------------------------------------------------------------------
// Model input
// ---------------------------------------------------------------------------

/** The SDK's `render_view` answer with a resolved view (`{ shown: true, elements, view: { v: 1, … } }`). */
function isSdkViewOutput(output: unknown): output is Json {
  return isRecord(output) && output.shown === true && isRecord(output.view) && output.view.v === 1;
}

/**
 * UI messages without the resolved `view` of `render_view` outputs:
 * projections never reach the model. The handler applies it on every
 * request, also with `chatViews` off, unless the app registers its own
 * `render_view` tool.
 */
export function withoutChatViewProjections<T>(messages: T[]): T[] {
  return messages.map((message) => {
    const parts = partsOf(message);
    if (parts.length === 0) return message;
    let changed = false;
    const next = parts.map((raw) => {
      const part = toolPartOf(raw);
      if (part?.toolName !== RENDER_VIEW_TOOL_NAME || !isSdkViewOutput(part.output)) return raw;
      changed = true;
      return { ...(raw as Json), output: renderViewModelOutput(part.output) };
    });
    return changed ? ({ ...(message as Json), parts: next } as T) : message;
  });
}

const MAX_MEMO_FIELDS = 12;
const MAX_MEMO_SAMPLE = 20;

/**
 * Field names of a list's entries the model may see: identifiers without a
 * run of three digits, as `read_result` echoes them. The memo is added after
 * the PII shield ran, so a key that is data (an e-mail-keyed map, an id)
 * must never appear in it.
 */
function fieldNames(entries: ReadonlyArray<unknown>): string[] {
  const names: string[] = [];
  for (const entry of entries.slice(0, MAX_MEMO_SAMPLE)) {
    if (!isRecord(entry)) continue;
    for (const key of Object.keys(entry)) {
      if (!key.startsWith('_') && echoableKey(key) && !names.includes(key)) names.push(key);
    }
  }
  return names.slice(0, MAX_MEMO_FIELDS);
}

/**
 * The shape of one result: its list (path and count) and field names, never
 * values; any other result is just `value` (its keys may be data).
 */
function shapeOf(output: unknown): string {
  const list = (path: string, entries: unknown[]) => {
    const fields = fieldNames(entries);
    return `${path}[] (${entries.length})${fields.length > 0 ? ` · fields: ${fields.join(', ')}` : ''}`;
  };
  if (Array.isArray(output)) return list('', output);
  if (!isRecord(output)) return 'value';
  const listKey = Array.isArray(output.data)
    ? 'data'
    : Object.keys(output).find((key) => !key.startsWith('_') && echoableKey(key) && Array.isArray(output[key])
      && (output[key] as unknown[]).some(isRecord));
  return listKey ? list(listKey, output[listKey] as unknown[]) : 'value';
}

/**
 * The source memo: one line per tool result of earlier turns a view may
 * reference (call id, tool, list path and count, field names), the newest
 * `CHAT_VIEW_LIMITS.maxSourceMemoEntries`. Content-free: no values.
 */
export function chatViewSourceMemo(messages: ReadonlyArray<unknown>): string | undefined {
  const lines: string[] = [];
  for (const message of messages.slice(0, Math.max(0, lastUserIndex(messages)))) {
    for (const raw of partsOf(message)) {
      const part = toolPartOf(raw);
      if (!part || part.state !== 'output-available' || !isReferenceableTool(part.toolName)
        || !isSuccessfulOutput(part.output)) continue;
      const partial = isCutOutput(part.toolName, part.output) ? ' · partial' : '';
      lines.push(`${part.toolCallId} · ${part.toolName} · ${shapeOf(part.output)}${partial}`);
    }
  }
  if (lines.length === 0) return undefined;
  return [
    'Tool results of earlier turns that render_view can reference ({"$ref": "<call id>", "path": …}):',
    ...lines.slice(-CHAT_VIEW_LIMITS.maxSourceMemoEntries),
  ].join('\n');
}
