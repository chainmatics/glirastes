import { wrapLanguageModel } from 'ai';
import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import { isPrivacyError, PrivacyError } from './detection-result.js';
import { extractIdentities as extractPeople, type KnownIdentity } from './known-identities.js';
import {
  attachmentDecision,
  BLOCKED_ATTACHMENTS,
  type AttachmentPolicySnapshot,
} from './attachment-policy.js';
import type { PrivacySession } from './strict-shield.js';

/** What the selected model can receive; checked again on every model switch. */
export interface ModelCapabilities {
  text?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  images?: boolean;
}

/**
 * Provider option keys that carry no content and may pass the boundary,
 * by provider namespace. Anything else in `providerOptions` stops the call.
 * The default allows the cache markers the handler sets itself.
 */
export type ProviderOptionsAllowlist = Readonly<Record<string, readonly string[]>>;

export const DEFAULT_PROVIDER_OPTIONS_ALLOWLIST: ProviderOptionsAllowlist = Object.freeze({
  anthropic: ['cacheControl'],
  openrouter: ['cacheControl', 'cache_control'],
  openai: ['parallelToolCalls', 'store', 'reasoningEffort', 'strictJsonSchema', 'structuredOutputs'],
  bedrock: ['cachePoint'],
});

export interface PrivacyBoundaryOptions {
  session: PrivacySession;
  /** Per-turn screenshot rule. Default: blocked. */
  attachments?: AttachmentPolicySnapshot;
  capabilities?: ModelCapabilities;
  providerOptions?: ProviderOptionsAllowlist;
  /**
   * Identities in tool results that the principal is authorized to see are
   * protected deterministically. `false` turns it off; a function replaces
   * the default JSON heuristic.
   */
  identitiesFromToolResults?: boolean | ((toolName: string, output: unknown) => KnownIdentity[]);
  /** Content-free notice of each stop, e.g. for metrics. */
  onBlocked?: (code: string) => void;
  /**
   * Runs before every model call of the turn (each step, retry and the
   * classifier), before anything is protected or sent. Throwing a
   * `PrivacyError` stops the call, e.g. `privacy_policy_revoked` once the
   * turn's policy revision was revoked between steps.
   */
  beforeModelCall?: () => void | Promise<void>;
  /** Content-free notice of each model call that passed the boundary. */
  onProtected?: () => void;
  /**
   * The caller builds the system and user messages from text this session
   * already protected, with the pseudonym-collision check of new input done
   * there (the intent classifier). The boundary still masks anything left
   * unprotected, but does not take those pseudonyms for raw input.
   */
  protectedPrompt?: boolean;
}

/** One turn's privacy boundary around the model, tools and display. */
export interface PrivacyBoundary {
  readonly session: PrivacySession;
  readonly attachments: AttachmentPolicySnapshot;
  readonly capabilities: Readonly<ModelCapabilities>;
  readonly middleware: LanguageModelV3Middleware;
  /** Wraps a provider model. Idempotent for the same boundary. */
  wrapModel<M>(model: M): M;
  /** Model-chosen tool input (pseudonyms) → authorized originals of this scope. */
  rehydrateToolInput<T>(input: T): T;
  /** Model text (pseudonyms) → text for the principal of this scope. */
  projectText(text: string): string;
}

const WRAPPED = Symbol.for('glirastes.privacy.wrappedModel');

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalToolInput(input: unknown): string {
  if (typeof input !== 'string') return canonicalJson(input);
  try {
    return canonicalJson(JSON.parse(input));
  } catch {
    return JSON.stringify(input);
  }
}
const WITHHELD_ATTACHMENT = '[Anhang nicht übertragen: Datenschutzregel / attachment withheld by privacy policy]';
const TOOL_FAILED = JSON.stringify({ success: false, error: 'tool_failed' });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkProviderOptions(options: SharedV3ProviderOptions | undefined, allowlist: ProviderOptionsAllowlist): void {
  if (!options) return;
  for (const [namespace, values] of Object.entries(options)) {
    if (values === undefined) continue;
    const allowed = allowlist[namespace];
    if (!allowed || !isPlainObject(values)) throw new PrivacyError('privacy_provider_option_blocked');
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.includes(key)) throw new PrivacyError('privacy_provider_option_blocked');
      if (!isOptionValue(value, 0)) throw new PrivacyError('privacy_provider_option_blocked');
    }
  }
}

/**
 * Provider references to an earlier response that the AI SDK copies from a
 * response into the next prompt: OpenAI item ids (they point to items the
 * provider stored) and encrypted reasoning (content the boundary cannot
 * read). Removed from history parts, so the provider receives the checked
 * content itself; any other unknown option still stops the call.
 */
const REPLAY_REFERENCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openai: ['itemId', 'reasoningEncryptedContent'],
});

function withoutReplayReferences<T extends { providerOptions?: SharedV3ProviderOptions }>(part: T): T {
  const options = part.providerOptions;
  if (!options) return part;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [namespace, values] of Object.entries(options)) {
    const drop = REPLAY_REFERENCES[namespace];
    if (!drop || !isPlainObject(values)) {
      next[namespace] = values;
      continue;
    }
    const kept = Object.fromEntries(Object.entries(values).filter(([key]) => !drop.includes(key)));
    if (Object.keys(kept).length !== Object.keys(values).length) changed = true;
    if (Object.keys(kept).length > 0) next[namespace] = kept;
  }
  if (!changed) return part;
  const { providerOptions: _removed, ...rest } = part;
  return (Object.keys(next).length > 0 ? { ...rest, providerOptions: next } : rest) as T;
}

/** Allowed options are flags, numbers and short enum tokens (`low`, `ephemeral`, `1h`), never free text. */
const OPTION_TOKEN = /^[a-z0-9_-]{1,24}$/;

function isOptionValue(value: unknown, depth: number): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return OPTION_TOKEN.test(value);
  if (depth >= 2 || !isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 8 && entries.every(([key, inner]) => OPTION_TOKEN.test(key.toLowerCase()) && isOptionValue(inner, depth + 1));
}

const SCHEMA_TEXT_KEYS = new Set(['description', 'title', '$comment']);
const SCHEMA_VALUE_KEYS = new Set(['default', 'examples']);
/** Validated values: a pseudonym would fail the tool's own input validation. */
const SCHEMA_FIXED_KEYS = new Set(['enum', 'const']);
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/**
 * Pseudonymizes the text of a JSON schema without changing its structure:
 * descriptions, titles, defaults and examples become protected text. An enum
 * or const value, or a property name, that is itself a protected value cannot
 * be replaced consistently (the tool validates its input against the
 * original), so the tool is withheld from the model instead.
 */
async function protectSchema(schema: unknown, session: PrivacySession, depth = 0): Promise<unknown> {
  if (depth > 32) throw new PrivacyError('privacy_tool_schema_blocked');
  if (Array.isArray(schema)) {
    const out: unknown[] = [];
    for (const item of schema) out.push(await protectSchema(item, session, depth + 1));
    return out;
  }
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_FIXED_KEYS.has(key)) {
      if (JSON.stringify(await session.pseudonymizeJson(value)) !== JSON.stringify(value)) {
        throw new PrivacyError('privacy_tool_schema_blocked');
      }
      out[key] = value;
    } else if (SCHEMA_TEXT_KEYS.has(key) && typeof value === 'string') {
      out[key] = await session.pseudonymizeText(value);
    } else if (SCHEMA_VALUE_KEYS.has(key)) {
      out[key] = await session.pseudonymizeJson(value);
    } else if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        if ((await session.pseudonymizeText(name)) !== name) throw new PrivacyError('privacy_tool_schema_blocked');
        mapped[name] = await protectSchema(child, session, depth + 1);
      }
      out[key] = mapped;
    } else if (key === 'required' && Array.isArray(value)) {
      out[key] = value;
    } else {
      out[key] = await protectSchema(value, session, depth + 1);
    }
  }
  return out;
}

export function createPrivacyBoundary(options: PrivacyBoundaryOptions): PrivacyBoundary {
  const { session } = options;
  const attachments = options.attachments ?? BLOCKED_ATTACHMENTS;
  const capabilities: ModelCapabilities = Object.freeze({ text: true, tools: true, structuredOutput: true, images: false, ...options.capabilities });
  const allowlist = options.providerOptions ?? DEFAULT_PROVIDER_OPTIONS_ALLOWLIST;
  const extractIdentities = options.identitiesFromToolResults === false
    ? undefined
    : typeof options.identitiesFromToolResults === 'function'
      ? options.identitiesFromToolResults
      : (_tool: string, output: unknown) => {
        const extraction = extractPeople(output);
        // A walk that stopped early would leave people unprotected: refuse.
        if (!extraction.complete) throw new PrivacyError('privacy_unsupported_content');
        return extraction.identities;
      };

  const blocked = (code: string) => {
    try {
      options.onBlocked?.(code);
    } catch {
      // Never let a metrics sink change the decision.
    }
  };

  // Server-side provenance: what this boundary itself received from the
  // model in this turn. Only such parts may hold pseudonyms when the next
  // step sends them back; everything else is raw text and a pseudonym in it
  // is a collision. A client cannot add to this record.
  const emittedTexts = new Set<string>();
  const emittedToolCalls = new Map<string, string>();
  const promptOrigin = options.protectedPrompt === true ? 'model' as const : 'raw' as const;
  const originOfText = (text: string) => (emittedTexts.has(text) ? 'model' as const : 'raw' as const);
  const originOfToolCall = (toolCallId: string, input: unknown) =>
    (emittedToolCalls.get(toolCallId) === canonicalToolInput(input) ? 'model' as const : 'raw' as const);

  async function protectFile(part: LanguageModelV3FilePart): Promise<LanguageModelV3FilePart | { type: 'text'; text: string }> {
    const decision = attachmentDecision(part, attachments, capabilities.images === true);
    if (decision.allowed) {
      checkProviderOptions(part.providerOptions, allowlist);
      return { ...part, ...(part.filename ? { filename: await session.pseudonymizeText(part.filename) } : {}) };
    }
    blocked(decision.code);
    return { type: 'text', text: WITHHELD_ATTACHMENT };
  }

  async function registerFromToolOutput(toolName: string, value: unknown): Promise<void> {
    if (!extractIdentities) return;
    const identities = extractIdentities(toolName, value);
    if (identities.length > 0) await session.registerIdentities(identities);
  }

  async function protectToolOutput(toolName: string, output: LanguageModelV3ToolResultOutput): Promise<LanguageModelV3ToolResultOutput> {
    checkProviderOptions((output as { providerOptions?: SharedV3ProviderOptions }).providerOptions, allowlist);
    switch (output.type) {
      case 'text':
        return { ...output, value: await session.pseudonymizeText(output.value) };
      case 'json':
        await registerFromToolOutput(toolName, output.value);
        return { ...output, value: await session.pseudonymizeJson(output.value) };
      case 'error-text':
      case 'error-json':
        // A thrown tool error may carry raw request or backend data. The model
        // gets a stable, content-free code only.
        return { type: 'error-text', value: TOOL_FAILED };
      case 'execution-denied':
        return { ...output, ...(output.reason ? { reason: await session.pseudonymizeText(output.reason) } : {}) };
      case 'content': {
        const value: typeof output.value = [];
        for (const item of output.value) {
          checkProviderOptions(item.providerOptions, allowlist);
          if (item.type === 'text') {
            value.push({ ...item, text: await session.pseudonymizeText(item.text) });
          } else if (item.type === 'file-data' || item.type === 'image-data') {
            const decision = attachmentDecision({ mediaType: item.mediaType, data: item.data }, attachments, capabilities.images === true);
            if (decision.allowed) value.push(item);
            else {
              blocked(decision.code);
              value.push({ type: 'text', text: WITHHELD_ATTACHMENT });
            }
          } else {
            blocked('privacy_attachment_blocked');
            value.push({ type: 'text', text: WITHHELD_ATTACHMENT });
          }
        }
        return { ...output, value };
      }
      default:
        throw new PrivacyError('privacy_unsupported_content');
    }
  }

  async function protectMessage(message: LanguageModelV3Message): Promise<LanguageModelV3Message> {
    checkProviderOptions(message.providerOptions, allowlist);
    switch (message.role) {
      case 'system':
        return { ...message, content: await session.pseudonymizeText(message.content, { origin: promptOrigin }) };
      case 'user': {
        const content: Array<(typeof message.content)[number]> = [];
        for (const part of message.content) {
          checkProviderOptions(part.providerOptions, allowlist);
          if (part.type === 'text') content.push({ ...part, text: await session.pseudonymizeText(part.text, { origin: promptOrigin }) });
          else if (part.type === 'file') content.push(await protectFile(part));
          else throw new PrivacyError('privacy_unsupported_content');
        }
        return { ...message, content };
      }
      case 'assistant': {
        const content: Array<(typeof message.content)[number]> = [];
        for (const raw of message.content) {
          const part = withoutReplayReferences(raw);
          checkProviderOptions(part.providerOptions, allowlist);
          switch (part.type) {
            case 'text':
            case 'reasoning':
              content.push({ ...part, text: await session.pseudonymizeText(part.text, { origin: originOfText(part.text) }) });
              break;
            case 'file':
              content.push(await protectFile(part));
              break;
            case 'tool-call':
              content.push({ ...part, input: await session.pseudonymizeJson(part.input, { origin: originOfToolCall(part.toolCallId, part.input) }) });
              break;
            case 'tool-result':
              content.push({ ...part, output: await protectToolOutput(part.toolName, part.output) });
              break;
            default:
              throw new PrivacyError('privacy_unsupported_content');
          }
        }
        return { ...message, content };
      }
      case 'tool': {
        const content: Array<(typeof message.content)[number]> = [];
        // Identities of every result first, so earlier results also mask them.
        for (const part of message.content) {
          if (part.type === 'tool-result' && part.output.type === 'json') await registerFromToolOutput(part.toolName, part.output.value);
        }
        for (const raw of message.content) {
          const part = withoutReplayReferences(raw);
          checkProviderOptions(part.providerOptions, allowlist);
          if (part.type === 'tool-result') content.push({ ...part, output: await protectToolOutput(part.toolName, part.output) });
          else if (part.type === 'tool-approval-response') {
            content.push({ ...part, ...(part.reason ? { reason: await session.pseudonymizeText(part.reason) } : {}) });
          } else throw new PrivacyError('privacy_unsupported_content');
        }
        return { ...message, content };
      }
      default:
        throw new PrivacyError('privacy_unsupported_content');
    }
  }

  async function transformParams(params: LanguageModelV3CallOptions): Promise<LanguageModelV3CallOptions> {
    try {
      await options.beforeModelCall?.();
      checkProviderOptions(params.providerOptions, allowlist);
      // Tool results of the whole prompt register their identities before any
      // message is masked, so a name from a later result is masked everywhere.
      for (const message of params.prompt) {
        if (message.role !== 'tool' && message.role !== 'assistant') continue;
        for (const part of message.content) {
          if (part.type === 'tool-result' && part.output.type === 'json') await registerFromToolOutput(part.toolName, part.output.value);
        }
      }
      const prompt: LanguageModelV3Message[] = [];
      for (const message of params.prompt) prompt.push(await protectMessage(message));
      let tools = params.tools;
      if (tools) {
        if (capabilities.tools === false) throw new PrivacyError('provider_capability_missing');
        tools = [];
        for (const tool of params.tools!) {
          // Provider-executed tools send content to provider-side services.
          if (tool.type !== 'function') throw new PrivacyError('privacy_tool_schema_blocked');
          checkProviderOptions(tool.providerOptions, allowlist);
          try {
            tools.push({
              ...tool,
              ...(tool.description ? { description: await session.pseudonymizeText(tool.description) } : {}),
              inputSchema: await protectSchema(tool.inputSchema, session) as JSONSchema7,
              ...(tool.inputExamples
                ? { inputExamples: await session.pseudonymizeJson(tool.inputExamples) as typeof tool.inputExamples }
                : {}),
            });
          } catch (error) {
            if (!isPrivacyError(error) || error.code !== 'privacy_tool_schema_blocked') throw error;
            // The tool is withheld; the rest of the turn continues.
            blocked(error.code);
          }
        }
        const choice = params.toolChoice;
        if (choice?.type === 'tool' && !tools.some((tool) => tool.name === choice.toolName)) {
          throw new PrivacyError('privacy_tool_schema_blocked');
        }
      }
      let responseFormat = params.responseFormat;
      if (responseFormat?.type === 'json') {
        if (capabilities.structuredOutput === false) throw new PrivacyError('provider_capability_missing');
        responseFormat = {
          ...responseFormat,
          ...(responseFormat.schema ? { schema: await protectSchema(responseFormat.schema, session) as JSONSchema7 } : {}),
          ...(responseFormat.description ? { description: await session.pseudonymizeText(responseFormat.description) } : {}),
          ...(responseFormat.name ? { name: await session.pseudonymizeText(responseFormat.name) } : {}),
        };
      }
      const stopSequences = params.stopSequences
        ? await Promise.all(params.stopSequences.map((s) => session.pseudonymizeText(s)))
        : undefined;
      try {
        options.onProtected?.();
      } catch {
        // A metrics sink never changes the decision.
      }
      return {
        ...params,
        prompt,
        ...(tools ? { tools } : {}),
        ...(responseFormat ? { responseFormat } : {}),
        ...(stopSequences ? { stopSequences } : {}),
      };
    } catch (error) {
      const code = isPrivacyError(error) ? error.code : 'privacy_unsupported_content';
      blocked(code);
      throw isPrivacyError(error) ? error : new PrivacyError('privacy_unsupported_content');
    }
  }

  function assertNoLeak(text: string): void {
    if (session.countLeaks(text) > 0) {
      blocked('privacy_output_leak');
      throw new PrivacyError('privacy_output_leak');
    }
  }

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => transformParams(params),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      for (const part of result.content as LanguageModelV3Content[]) {
        if (part.type === 'text' || part.type === 'reasoning') {
          assertNoLeak(part.text);
          emittedTexts.add(part.text);
        } else if (part.type === 'tool-call') {
          assertNoLeak(part.input);
          emittedToolCalls.set(part.toolCallId, canonicalToolInput(part.input));
        }
      }
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      // Deltas are held per part and released only after the whole part
      // passed the leak check, so no consumer ever sees a leaking fragment.
      const held = new Map<string, LanguageModelV3StreamPart[]>();
      const texts = new Map<string, string>();
      const hold = (key: string, part: LanguageModelV3StreamPart, delta: string) => {
        held.set(key, [...(held.get(key) ?? []), part]);
        texts.set(key, (texts.get(key) ?? '') + delta);
      };
      const release = (key: string, controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
        assertNoLeak(texts.get(key) ?? '');
        if (!key.startsWith('tool:')) emittedTexts.add(texts.get(key) ?? '');
        for (const part of held.get(key) ?? []) controller.enqueue(part);
        held.delete(key);
        texts.delete(key);
      };
      const checker = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          try {
            switch (part.type) {
              case 'text-delta':
                hold(`text:${part.id}`, part, part.delta);
                return;
              case 'reasoning-delta':
                hold(`reasoning:${part.id}`, part, part.delta);
                return;
              case 'tool-input-delta':
                hold(`tool:${part.id}`, part, part.delta);
                return;
              case 'text-end':
                release(`text:${part.id}`, controller);
                break;
              case 'reasoning-end':
                release(`reasoning:${part.id}`, controller);
                break;
              case 'tool-input-end':
                release(`tool:${part.id}`, controller);
                break;
              case 'tool-call':
                assertNoLeak(part.input);
                emittedToolCalls.set(part.toolCallId, canonicalToolInput(part.input));
                break;
              default:
                break;
            }
            controller.enqueue(part);
          } catch (error) {
            held.clear();
            texts.clear();
            controller.enqueue({ type: 'error', error });
            controller.terminate();
          }
        },
        flush(controller) {
          // A part without its end was never checked: it is not released, and
          // the caller learns that the answer is incomplete.
          const incomplete = held.size > 0;
          held.clear();
          texts.clear();
          if (incomplete) controller.enqueue({ type: 'error', error: new PrivacyError('privacy_output_incomplete') });
        },
      });
      return { ...result, stream: result.stream.pipeThrough(checker) };
    },
  };

  const boundary: PrivacyBoundary = {
    session,
    attachments,
    capabilities,
    middleware,
    wrapModel<M>(model: M): M {
      if (typeof model !== 'object' || model === null) throw new PrivacyError('privacy_unsupported_content');
      const marker = (model as Record<symbol, unknown>)[WRAPPED] as PrivacyBoundary | undefined;
      if (marker === boundary) return model;
      if (marker) throw new PrivacyError('privacy_scope_invalid');
      const v3 = model as unknown as LanguageModelV3;
      if (v3.specificationVersion !== 'v3') throw new PrivacyError('privacy_unsupported_content');
      const wrapped = wrapLanguageModel({ model: v3, middleware });
      Object.defineProperty(wrapped, WRAPPED, { value: boundary, enumerable: false });
      return wrapped as unknown as M;
    },
    rehydrateToolInput: (input) => session.rehydrateToolInput(input),
    projectText: (text) => session.rehydrateText(text),
  };
  return boundary;
}

/** True when the model was wrapped by a privacy boundary. */
export function isPrivacyWrappedModel(model: unknown): boolean {
  return typeof model === 'object' && model !== null && Boolean((model as Record<symbol, unknown>)[WRAPPED]);
}
