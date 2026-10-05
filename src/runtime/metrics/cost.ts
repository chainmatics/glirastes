import { z } from 'zod';
import {
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_PRICING_VERSION_PATTERN,
  type RuntimeTurnCost,
} from '../../contracts/index.js';

const usdPerMillion = z.number().finite().nonnegative().max(10_000);

/**
 * Prices for models whose provider reports no cost. A provider-reported cost
 * always wins; the table only fills gaps and every estimate names its
 * `version`. Glirastes ships no default table: prices change, and a stale
 * table would be wrong without anyone noticing.
 */
export const RuntimePriceTableSchema = z.object({
  version: z.string().regex(RUNTIME_PRICING_VERSION_PATTERN),
  models: z.record(
    z.string().regex(RUNTIME_METRIC_LABEL_PATTERN),
    z.object({
      inputUsdPerMillion: usdPerMillion,
      outputUsdPerMillion: usdPerMillion,
    }).strict(),
  ),
}).strict();

export type RuntimePriceTable = z.infer<typeof RuntimePriceTableSchema>;

export const UNKNOWN_TURN_COST: RuntimeTurnCost = Object.freeze({
  usd: null,
  source: null,
  pricingVersion: null,
});

export interface StepCostInput {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** AI SDK `providerMetadata` of the step. */
  providerMetadata?: unknown;
  /** AI SDK `usage.raw` of the step (the provider's own usage object). */
  usageRaw?: unknown;
  /**
   * Cost found in the step's raw stream chunks (`rawChunkCostUsd`). The
   * OpenAI-compatible provider strips OpenRouter's `usage.cost` from
   * `usage.raw`; only the raw chunk keeps it.
   */
  rawChunkCostUsd?: number | null;
}

function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function usableAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The cost an OpenRouter stream chunk carries (`usage.cost` of the final
 * chunk), as delivered by `streamText({ includeRawChunks: true })`.
 */
export function rawChunkCostUsd(rawValue: unknown): number | null {
  return usableAmount(child(child(rawValue, 'usage'), 'cost'));
}

/**
 * The cost the provider reported for one model step, in USD: OpenRouter's
 * official provider puts it at `providerMetadata.openrouter.usage.cost`,
 * providers that keep unknown usage fields at `usage.raw.cost`, and the
 * OpenAI-compatible provider (`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`)
 * only in the raw stream chunk.
 */
export function providerReportedCostUsd(input: {
  providerMetadata?: unknown;
  usageRaw?: unknown;
  rawChunkCostUsd?: number | null;
}): number | null {
  return usableAmount(child(child(child(input.providerMetadata, 'openrouter'), 'usage'), 'cost'))
    ?? usableAmount(child(input.usageRaw, 'cost'))
    ?? usableAmount(input.rawChunkCostUsd);
}

export function resolveStepCost(
  input: StepCostInput,
  priceTable?: RuntimePriceTable,
): RuntimeTurnCost {
  const reported = providerReportedCostUsd(input);
  if (reported !== null) {
    return { usd: reported, source: 'provider-reported', pricingVersion: null };
  }
  const price = input.model && priceTable
    && Object.hasOwn(priceTable.models, input.model)
    ? priceTable.models[input.model]
    : undefined;
  if (!price || !priceTable) return UNKNOWN_TURN_COST;
  return {
    usd: (input.inputTokens * price.inputUsdPerMillion
      + input.outputTokens * price.outputUsdPerMillion) / 1_000_000,
    source: 'price-table',
    pricingVersion: priceTable.version,
  };
}

/**
 * A turn's cost is known only when every model step's cost is known. Any
 * estimated step makes the whole turn a price-table cost.
 */
export function combineTurnCost(
  steps: ReadonlyArray<RuntimeTurnCost>,
): RuntimeTurnCost {
  if (steps.length === 0 || steps.some((step) => step.usd === null)) {
    return UNKNOWN_TURN_COST;
  }
  const usd = steps.reduce((sum, step) => sum + (step.usd ?? 0), 0);
  const estimated = steps.find((step) => step.source === 'price-table');
  return estimated
    ? { usd, source: 'price-table', pricingVersion: estimated.pricingVersion }
    : { usd, source: 'provider-reported', pricingVersion: null };
}
