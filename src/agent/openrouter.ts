import type { LanguageModel } from 'ai';

/**
 * Model access of the managed job (spec 4.6): OpenRouter through the
 * OpenAI-compatible chat provider, with the Platform's routing rules
 * (`provider: { data_collection: 'deny', zdr: true, require_parameters: true }`,
 * `usage: { include: true }`) merged into every completion request, and a
 * start check that the pinned model supports tools and structured output.
 */

export type ModelAccessCode = 'models_unreachable' | 'model_unsupported';

export class ModelAccessError extends Error {
  constructor(readonly code: ModelAccessCode) {
    super(code);
    this.name = 'ModelAccessError';
  }
}

/** The only parts of `@ai-sdk/openai` the runner uses; injected so tests and `tools check` never load it. */
export type CreateOpenAI = (settings: {
  baseURL: string;
  apiKey: string;
  name?: string;
  fetch?: typeof fetch;
}) => { chat(modelId: string): LanguageModel };

/** Merges the routing rules into every JSON POST body, leaving everything else as it is. */
export function withJobRouting(routing: Record<string, unknown>, baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return baseFetch(input, init);
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return baseFetch(input, init);
    return baseFetch(input, { ...init, body: JSON.stringify({ ...body, ...routing }) });
  }) as typeof fetch;
}

function supportsJob(parameters: unknown): boolean {
  if (!Array.isArray(parameters)) return false;
  return parameters.includes('tools')
    && (parameters.includes('structured_outputs') || parameters.includes('response_format'));
}

/**
 * The pinned model, or the pinned fallback when OpenRouter's model list says
 * the first one lacks tools or structured output. Never an alias.
 */
export async function selectJobModel(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ model: string; fallbackUsed: boolean }> {
  let listed: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}` },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new ModelAccessError('models_unreachable');
    listed = await response.json();
  } catch {
    throw new ModelAccessError('models_unreachable');
  }
  const models = (listed as { data?: unknown } | undefined)?.data;
  const entries = Array.isArray(models) ? models as Array<{ id?: unknown; supported_parameters?: unknown }> : [];
  const supported = (id: string) => entries.some((entry) => entry.id === id && supportsJob(entry.supported_parameters));
  if (supported(options.model)) return { model: options.model, fallbackUsed: false };
  if (supported(options.fallbackModel)) return { model: options.fallbackModel, fallbackUsed: true };
  throw new ModelAccessError('model_unsupported');
}

export function createJobModel(options: {
  createOpenAI: CreateOpenAI;
  baseUrl: string;
  apiKey: string;
  model: string;
  routing: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): LanguageModel {
  return options.createOpenAI({
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    name: 'openrouter',
    fetch: withJobRouting(options.routing, options.fetchImpl),
  }).chat(options.model);
}

/** OpenRouter's provider-reported cost of one step (`usage.cost` with `usage: { include: true }`). */
export function stepCostUsd(step: { response?: { body?: unknown } }): number | undefined {
  const cost = (step.response?.body as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
