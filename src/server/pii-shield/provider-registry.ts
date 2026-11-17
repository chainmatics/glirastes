/**
 * Interchangeable model providers behind one privacy boundary.
 *
 * The server owns a list of selectable entries (adapter, model, secret
 * reference, capabilities, who may select it). The browser only ever sees
 * an entry id and its label; the user's choice is that id, never a URL, key
 * or model string. Resolution happens once per turn, and an invalid choice
 * fails with `provider_not_allowed` instead of falling back to another
 * provider. Every model the registry hands out is still wrapped by the
 * turn's privacy boundary: switching providers needs no change to the
 * shield.
 */
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { PrivacyError } from './detection-result.js';
import type { PrivacyScope } from './mapping-store.js';
import type { ModelCapabilities } from './model-boundary.js';

export interface ProviderModelInput {
  modelId: string;
  /** The resolved server-side secret of the entry. */
  apiKey: string;
  /** Server-configured endpoint override, never from the browser. */
  baseURL?: string;
}

/** Builds models of one provider family. Factories are injected, so the SDK has no provider dependency. */
export interface ProviderAdapter {
  readonly id: string;
  /**
   * True once the adapter passed the provider conformance contract (stream
   * and non-stream, tools, structured output, errors and retries, history,
   * screenshot modes) behind the privacy boundary. Unqualified adapters are
   * refused in the protected profile.
   */
  readonly qualified: boolean;
  createModel(input: ProviderModelInput): LanguageModelV3;
}

export interface ProviderEntry {
  /** Selection id, stable and URL-safe. */
  id: string;
  /** Display label for the model picker and the privacy status line. */
  label: string;
  adapter: string;
  modelId: string;
  /** Name of the server-side secret (e.g. an environment variable), resolved by `secrets`. */
  secretRef: string;
  baseURL?: string;
  capabilities?: ModelCapabilities;
  /** Who may select this entry. Default: every scope. */
  allowed?: (scope: PrivacyScope) => boolean;
}

export interface ProviderOption {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface ResolvedProvider extends ProviderOption {
  model: LanguageModelV3;
}

export interface ProviderRegistryConfig {
  adapters: ReadonlyArray<ProviderAdapter>;
  entries: ReadonlyArray<ProviderEntry>;
  /** Used when the user made no choice. Must be an entry id; checked like a choice. */
  defaultEntry: string;
  /** Resolves a `secretRef` on the server. Return `undefined` when it is not configured. */
  secrets: (secretRef: string) => string | undefined;
  /** Accept adapters without `qualified: true`. Only outside the protected profile. Default: false. */
  allowUnqualified?: boolean;
}

export interface ProviderRegistry {
  /** The entries this scope may select, without secrets or endpoints. */
  options(scope: PrivacyScope): ProviderOption[];
  /**
   * The model for this turn. `selection` is the entry id the user chose
   * (absent: the default). Throws `provider_not_allowed` for an unknown,
   * foreign or unqualified choice and `provider_unavailable` for a missing
   * secret. Never substitutes another provider.
   */
  resolve(scope: PrivacyScope, selection?: string | null): ResolvedProvider;
  /** For `ChatPrivacyConfig.modelCapabilities`: capabilities of a model this registry built. */
  capabilitiesOf(model: unknown): ModelCapabilities | undefined;
  /** For `ChatPrivacyConfig.providerLabel`: label of a model this registry built. */
  labelOf(model: unknown): string | undefined;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = { images: false };
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function createProviderRegistry(config: ProviderRegistryConfig): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
  for (const adapter of config.adapters) {
    if (adapters.has(adapter.id)) throw new Error(`Duplicate provider adapter "${adapter.id}"`);
    adapters.set(adapter.id, adapter);
  }
  const entries = new Map<string, ProviderEntry>();
  for (const entry of config.entries) {
    if (!ENTRY_ID.test(entry.id)) throw new Error(`Invalid provider entry id "${entry.id}"`);
    if (entries.has(entry.id)) throw new Error(`Duplicate provider entry "${entry.id}"`);
    if (!adapters.has(entry.adapter)) throw new Error(`Provider entry "${entry.id}" names an unknown adapter`);
    entries.set(entry.id, Object.freeze({ ...entry }));
  }
  if (!entries.has(config.defaultEntry)) throw new Error('The default provider entry is not configured');

  const built = new WeakMap<object, ProviderOption>();
  const option = (entry: ProviderEntry): ProviderOption => ({
    id: entry.id,
    label: entry.label,
    capabilities: { ...DEFAULT_CAPABILITIES, ...entry.capabilities },
  });
  const permitted = (entry: ProviderEntry, scope: PrivacyScope): boolean => {
    const adapter = adapters.get(entry.adapter)!;
    if (!adapter.qualified && !config.allowUnqualified) return false;
    try {
      return entry.allowed ? entry.allowed(scope) === true : true;
    } catch {
      return false;
    }
  };

  return {
    options(scope) {
      return [...entries.values()].filter((entry) => permitted(entry, scope)).map(option);
    },
    resolve(scope, selection) {
      const id = selection === undefined || selection === null || selection === '' ? config.defaultEntry : selection;
      const entry = typeof id === 'string' ? entries.get(id) : undefined;
      if (!entry || !permitted(entry, scope)) throw new PrivacyError('provider_not_allowed');
      const apiKey = config.secrets(entry.secretRef);
      if (typeof apiKey !== 'string' || apiKey.length === 0) throw new PrivacyError('provider_unavailable');
      const model = adapters.get(entry.adapter)!.createModel({
        modelId: entry.modelId,
        apiKey,
        ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
      });
      const resolved = option(entry);
      built.set(model, resolved);
      return { ...resolved, model };
    },
    capabilitiesOf(model) {
      return typeof model === 'object' && model !== null ? built.get(model)?.capabilities : undefined;
    },
    labelOf(model) {
      return typeof model === 'object' && model !== null ? built.get(model)?.label : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** The parts of `createOpenAI` (`@ai-sdk/openai`) an adapter uses. */
export type CreateOpenAIProvider = (settings: {
  baseURL?: string;
  apiKey: string;
  name?: string;
  fetch?: typeof globalThis.fetch;
}) => { chat(modelId: string): unknown };

/** The parts of `createAnthropic` (`@ai-sdk/anthropic`) an adapter uses. */
export type CreateAnthropicProvider = (settings: {
  baseURL?: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}) => (modelId: string) => unknown;

/**
 * OpenRouter's provider routing for the protected profile: only the named
 * upstream providers, no fallback to others, no data collection, zero data
 * retention endpoints only.
 */
export interface OpenRouterRoutingPolicy {
  only?: string[];
  allow_fallbacks?: false;
  data_collection?: 'deny';
  zdr?: true;
}

export const STRICT_OPENROUTER_ROUTING: Readonly<OpenRouterRoutingPolicy> = Object.freeze({
  allow_fallbacks: false,
  data_collection: 'deny',
  zdr: true,
});

/**
 * Merges the routing policy into the `provider` field of every JSON POST
 * body. The policy's keys win over anything the request already set; a body
 * that is not a JSON object is refused rather than sent without routing.
 */
export function withOpenRouterRouting(
  policy: OpenRouterRoutingPolicy,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const routing = { ...STRICT_OPENROUTER_ROUTING, ...policy };
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (init?.method?.toUpperCase() !== 'POST') return baseFetch(input, init);
    let body: unknown;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new PrivacyError('provider_not_allowed');
    }
    const record = body as Record<string, unknown>;
    const existing = record.provider && typeof record.provider === 'object' && !Array.isArray(record.provider)
      ? record.provider as Record<string, unknown>
      : {};
    return baseFetch(input, { ...init, body: JSON.stringify({ ...record, provider: { ...existing, ...routing } }) });
  }) as typeof globalThis.fetch;
}

function asV3(model: unknown): LanguageModelV3 {
  if (typeof model !== 'object' || model === null || (model as { specificationVersion?: unknown }).specificationVersion !== 'v3') {
    throw new PrivacyError('provider_not_allowed');
  }
  return model as LanguageModelV3;
}

/** OpenRouter through the OpenAI-compatible chat API, with the routing policy in every request body. */
export function openRouterAdapter(options: {
  createOpenAI: CreateOpenAIProvider;
  routing?: OpenRouterRoutingPolicy;
  /** Transport under the routing wrapper (tests, proxies). */
  fetch?: typeof globalThis.fetch;
  id?: string;
}): ProviderAdapter {
  return {
    id: options.id ?? 'openrouter',
    qualified: true,
    createModel({ modelId, apiKey, baseURL }) {
      const provider = options.createOpenAI({
        baseURL: baseURL ?? 'https://openrouter.ai/api/v1',
        apiKey,
        name: 'openrouter',
        fetch: withOpenRouterRouting(options.routing ?? {}, options.fetch),
      });
      return asV3(provider.chat(modelId));
    },
  };
}

/** Anthropic's Messages API directly. Gets no OpenRouter fields. */
export function anthropicAdapter(options: {
  createAnthropic: CreateAnthropicProvider;
  fetch?: typeof globalThis.fetch;
  id?: string;
}): ProviderAdapter {
  return {
    id: options.id ?? 'anthropic',
    qualified: true,
    createModel({ modelId, apiKey, baseURL }) {
      const provider = options.createAnthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return asV3(provider(modelId));
    },
  };
}

/** Any OpenAI-compatible chat endpoint (OpenAI, Azure OpenAI proxies, local servers). */
export function openAiCompatibleAdapter(options: {
  id: string;
  createOpenAI: CreateOpenAIProvider;
  fetch?: typeof globalThis.fetch;
}): ProviderAdapter {
  return {
    id: options.id,
    qualified: true,
    createModel({ modelId, apiKey, baseURL }) {
      const provider = options.createOpenAI({
        apiKey,
        name: options.id,
        ...(baseURL ? { baseURL } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return asV3(provider.chat(modelId));
    },
  };
}
