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
import {
  normalizeProviderEndpoint,
  ProviderBindingSchema,
  type EffectivePrivacyPolicy,
  type ProviderBinding,
} from '../../contracts/privacy-policy.js';
import { providerBindingDigest } from '../../sync/privacy-digest.js';
import { PrivacyError } from './detection-result.js';
import type { PrivacyScope } from './mapping-store.js';
import type { ModelCapabilities } from './model-boundary.js';

export interface ProviderModelInput {
  modelId: string;
  /** The resolved server-side secret of the entry. */
  apiKey: string;
  /** Server-configured endpoint override, never from the browser. */
  baseURL?: string;
  /**
   * Upstream providers the effective privacy policy allows for this turn
   * (`openRouterOnly`). Only passed to adapters whose binding protocol is
   * `OPENROUTER_PROTOCOL`; such an adapter must send exactly this list (never
   * empty, never wider).
   */
  upstreamOnly?: readonly string[];
}

/** Protocol of an adapter that routes through OpenRouter and honors `upstreamOnly`. */
export const OPENROUTER_PROTOCOL = 'openrouter-chat';

/**
 * The security-relevant, non-secret description of what an adapter sends
 * where. Without it an adapter's entries have no binding digest and are
 * never approved by a privacy policy.
 */
export interface ProviderAdapterBinding {
  /** Wire protocol, e.g. `openai-chat`, `anthropic-messages`, `openrouter-chat`. */
  protocol: string;
  /** Endpoint used when the entry sets no `baseURL`. */
  defaultEndpoint: string;
  /** Routing the adapter always applies; part of the digest. */
  routing?: ProviderBinding['routing'];
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
  /** Binding description; required for an entry to be approvable. */
  readonly binding?: ProviderAdapterBinding;
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

/**
 * The provider part of the effective privacy policy of a turn. Without a
 * signed block (`allowed: null`) the local `providerEntryIds` narrow the
 * offer as `offeredEntryIds`.
 */
export type ProviderPolicyConstraint = EffectivePrivacyPolicy['providers'] & {
  offeredEntryIds?: readonly string[];
};

export interface ProviderRegistry {
  /**
   * The entries this scope may select, without secrets or endpoints. With a
   * policy constraint only the entries the policy allows (with
   * `userChoice: false`, only the policy default).
   */
  options(scope: PrivacyScope, constraint?: ProviderPolicyConstraint): ProviderOption[];
  /**
   * The model for this turn. `selection` is the entry id the user chose
   * (absent: the default). Throws `provider_not_allowed` for an unknown,
   * foreign or unqualified choice and `provider_unavailable` for a missing
   * secret. Never substitutes another provider.
   *
   * With a policy constraint (protected profile) the default is the policy's,
   * a choice counts only with `userChoice`, and an entry must have a binding
   * whose digest matches its approval at this moment; an approval for the
   * same id with another endpoint, model or routing does not apply. An empty
   * `openRouterOnly` makes OpenRouter entries `provider_unavailable`.
   */
  resolve(scope: PrivacyScope, selection?: string | null, constraint?: ProviderPolicyConstraint): ResolvedProvider;
  /** The registry's own default entry id. */
  readonly defaultEntryId: string;
  /** Entry id → `providerBindingDigest` of every entry whose adapter describes its binding. */
  bindings(): Record<string, string>;
  /** The binding of an entry, or undefined without one. Content-free: no secret, no secret name. */
  bindingOf(entryId: string): ProviderBinding | undefined;
  /** For `ChatPrivacyConfig.modelCapabilities`: capabilities of a model this registry built. */
  capabilitiesOf(model: unknown): ModelCapabilities | undefined;
  /** For `ChatPrivacyConfig.providerLabel`: label of a model this registry built. */
  labelOf(model: unknown): string | undefined;
  /**
   * True only for a model this registry built by `resolve` under exactly
   * this constraint, whose entry is still approved by it. Every model call
   * of a turn with a signed approval list is held to it, the classifier's
   * included: another model, or the same entry built without the approval,
   * is refused before any request.
   */
  approves(model: unknown, constraint: ProviderPolicyConstraint): boolean;
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

  const bindingsById = new Map<string, { binding: ProviderBinding; digest: string }>();
  for (const entry of entries.values()) {
    const adapter = adapters.get(entry.adapter)!;
    if (!adapter.binding) continue;
    const binding = ProviderBindingSchema.parse({
      v: 1,
      adapter: adapter.id,
      adapterProtocol: adapter.binding.protocol,
      endpoint: normalizeProviderEndpoint(entry.baseURL ?? adapter.binding.defaultEndpoint),
      modelId: entry.modelId,
      routing: adapter.binding.routing ?? {},
      capabilities: { images: entry.capabilities?.images === true },
    });
    bindingsById.set(entry.id, Object.freeze({ binding, digest: providerBindingDigest(binding) }));
  }

  const built = new WeakMap<object, ProviderOption>();
  const builtUnder = new WeakMap<object, { entry: ProviderEntry; constraint: ProviderPolicyConstraint | undefined }>();
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

  /**
   * Whether a constraint lets this entry run at all: it needs a binding the
   * digest can name and the local offer; a signed list also needs that
   * binding approved.
   */
  const approved = (entry: ProviderEntry, constraint: ProviderPolicyConstraint): boolean => {
    if (constraint.offeredEntryIds && !constraint.offeredEntryIds.includes(entry.id)) return false;
    const bound = bindingsById.get(entry.id);
    if (!bound) return false;
    if (constraint.allowed === null) return true;
    return constraint.allowed.some((a) => a.entryId === entry.id && a.bindingDigest === bound.digest);
  };
  const isUpstreamRouted = (entry: ProviderEntry) => adapters.get(entry.adapter)!.binding?.protocol === OPENROUTER_PROTOCOL;

  return {
    defaultEntryId: config.defaultEntry,
    bindings() {
      return Object.fromEntries([...bindingsById].map(([id, bound]) => [id, bound.digest]));
    },
    bindingOf(entryId) {
      const bound = bindingsById.get(entryId);
      return bound ? structuredClone(bound.binding) : undefined;
    },
    options(scope, constraint) {
      return [...entries.values()]
        .filter((entry) => permitted(entry, scope))
        .filter((entry) => !constraint || (
          approved(entry, constraint)
          && (constraint.userChoice || entry.id === constraint.defaultEntryId)
          && !(isUpstreamRouted(entry) && constraint.openRouterOnly?.length === 0)
        ))
        .map(option);
    },
    resolve(scope, selection, constraint) {
      const chosen = selection === undefined || selection === null || selection === '' ? undefined : selection;
      let id: unknown;
      if (constraint) {
        // No substitute: an unusable policy default or a choice the policy
        // does not open to the user stops the turn.
        if (chosen !== undefined && !constraint.userChoice && chosen !== constraint.defaultEntryId) {
          throw new PrivacyError('provider_not_allowed');
        }
        id = chosen ?? constraint.defaultEntryId;
      } else {
        id = chosen ?? config.defaultEntry;
      }
      const entry = typeof id === 'string' ? entries.get(id) : undefined;
      if (!entry || !permitted(entry, scope)) throw new PrivacyError('provider_not_allowed');
      if (constraint && !approved(entry, constraint)) throw new PrivacyError('provider_not_allowed');
      const upstreamOnly = constraint && isUpstreamRouted(entry) ? constraint.openRouterOnly : undefined;
      if (upstreamOnly && upstreamOnly.length === 0) throw new PrivacyError('provider_unavailable');
      const apiKey = config.secrets(entry.secretRef);
      if (typeof apiKey !== 'string' || apiKey.length === 0) throw new PrivacyError('provider_unavailable');
      const model = adapters.get(entry.adapter)!.createModel({
        modelId: entry.modelId,
        apiKey,
        ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
        ...(upstreamOnly ? { upstreamOnly: [...upstreamOnly] } : {}),
      });
      const resolved = option(entry);
      built.set(model, resolved);
      builtUnder.set(model, { entry, constraint });
      return { ...resolved, model };
    },
    approves(model, constraint) {
      if (typeof model !== 'object' || model === null) return false;
      const record = builtUnder.get(model);
      return record !== undefined && record.constraint === constraint && approved(record.entry, constraint);
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
 * Sets the `provider` field of every JSON POST body to exactly the routing
 * policy. Only `only` comes from the caller; the strict values are applied
 * last, and whatever `provider` the request carried is replaced, so neither
 * the request nor an option (`undefined` included) can remove, change or
 * add to what the binding digest certifies. A body that is not a JSON
 * object is refused rather than sent without routing.
 */
export function withOpenRouterRouting(
  policy: OpenRouterRoutingPolicy,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const routing: Record<string, unknown> = {
    ...(Array.isArray(policy.only) ? { only: [...policy.only] } : {}),
    ...STRICT_OPENROUTER_ROUTING,
  };
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
    return baseFetch(input, { ...init, body: JSON.stringify({ ...(body as Record<string, unknown>), provider: { ...routing } }) });
  }) as typeof globalThis.fetch;
}

function asV3(model: unknown): LanguageModelV3 {
  if (typeof model !== 'object' || model === null || (model as { specificationVersion?: unknown }).specificationVersion !== 'v3') {
    throw new PrivacyError('provider_not_allowed');
  }
  return model as LanguageModelV3;
}

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
/** The defaults of `@ai-sdk/anthropic` and `@ai-sdk/openai` when no `baseURL` is set. */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1';

/** OpenRouter through the OpenAI-compatible chat API, with the routing policy in every request body. */
export function openRouterAdapter(options: {
  createOpenAI: CreateOpenAIProvider;
  routing?: OpenRouterRoutingPolicy;
  /** Transport under the routing wrapper (tests, proxies). */
  fetch?: typeof globalThis.fetch;
  id?: string;
}): ProviderAdapter {
  const configuredOnly = options.routing?.only;
  return {
    id: options.id ?? 'openrouter',
    qualified: true,
    binding: {
      protocol: OPENROUTER_PROTOCOL,
      defaultEndpoint: OPENROUTER_ENDPOINT,
      routing: {
        allowFallbacks: false,
        dataCollection: 'deny',
        zdr: true,
        ...(configuredOnly ? { only: [...configuredOnly] } : {}),
      },
    },
    createModel({ modelId, apiKey, baseURL, upstreamOnly }) {
      // The policy can only narrow the configured upstream list, never widen it.
      const only = upstreamOnly
        ? (configuredOnly ? configuredOnly.filter((slug) => upstreamOnly.includes(slug)) : [...upstreamOnly])
        : configuredOnly;
      if (only && only.length === 0) throw new PrivacyError('provider_unavailable');
      const provider = options.createOpenAI({
        baseURL: baseURL ?? OPENROUTER_ENDPOINT,
        apiKey,
        name: 'openrouter',
        fetch: withOpenRouterRouting(only ? { only: [...only] } : {}, options.fetch),
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
    binding: { protocol: 'anthropic-messages', defaultEndpoint: ANTHROPIC_ENDPOINT },
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

/**
 * Any OpenAI-compatible chat endpoint (OpenAI, Azure OpenAI proxies, local
 * servers). Entries without `baseURL` go to OpenAI's API.
 */
export function openAiCompatibleAdapter(options: {
  id: string;
  createOpenAI: CreateOpenAIProvider;
  fetch?: typeof globalThis.fetch;
}): ProviderAdapter {
  return {
    id: options.id,
    qualified: true,
    binding: { protocol: 'openai-chat', defaultEndpoint: OPENAI_ENDPOINT },
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
