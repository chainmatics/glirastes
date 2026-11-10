import { describe, expect, it } from 'vitest';
import {
  combineTurnCost,
  providerReportedCostUsd,
  rawChunkCostUsd,
  resolveStepCost,
  RuntimePriceTableSchema,
  UNKNOWN_TURN_COST,
  type RuntimePriceTable,
} from './cost.js';

const priceTable: RuntimePriceTable = {
  version: 'openrouter-2026-10-04',
  models: {
    'anthropic/claude-sonnet-5.5': { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  },
};

describe('rawChunkCostUsd', () => {
  it('reads OpenRouter usage.cost from the final raw stream chunk', () => {
    expect(rawChunkCostUsd({
      id: 'gen-1',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0042 },
    })).toBe(0.0042);
  });

  it.each([
    ['a content chunk', { choices: [{ delta: { content: 'Hallo' } }] }],
    ['usage without cost', { usage: { prompt_tokens: 1 } }],
    ['a non-object chunk', 'data: [DONE]'],
    ['nothing', undefined],
  ])('finds no cost in %s', (_label, chunk) => {
    expect(rawChunkCostUsd(chunk)).toBeNull();
  });
});

// The provider metadata and usage.raw shapes below are modelled on OpenRouter's
// documentation with hand-written objects: @openrouter/ai-sdk-provider is not
// installed, so the real package's metadata is not checked here.
describe('providerReportedCostUsd', () => {
  it('reads usage.cost from the modelled official provider metadata shape', () => {
    expect(providerReportedCostUsd({
      providerMetadata: { openrouter: { usage: { cost: 0.0042, totalTokens: 10 } } },
    })).toBe(0.0042);
  });

  it('reads cost from a modelled raw provider usage object', () => {
    expect(providerReportedCostUsd({ usageRaw: { prompt_tokens: 10, cost: 0.001 } }))
      .toBe(0.001);
  });

  it('falls back to the cost of the step raw stream chunk', () => {
    expect(providerReportedCostUsd({ usageRaw: { prompt_tokens: 10 }, rawChunkCostUsd: 0.002 }))
      .toBe(0.002);
  });

  it('prefers provider metadata over raw usage and the raw chunk', () => {
    expect(providerReportedCostUsd({
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
      usageRaw: { cost: 0.4 },
      rawChunkCostUsd: 0.3,
    })).toBe(0.5);
  });

  it('accepts a reported cost of exactly zero (free models)', () => {
    expect(providerReportedCostUsd({ usageRaw: { cost: 0 } })).toBe(0);
  });

  it.each([
    ['nothing reported', {}],
    ['a string', { usageRaw: { cost: '0.01' } }],
    ['a negative amount', { usageRaw: { cost: -1 } }],
    ['not finite', { usageRaw: { cost: Number.POSITIVE_INFINITY } }],
    ['a non-object metadata', { providerMetadata: 'openrouter' }],
    ['a negative raw chunk cost', { rawChunkCostUsd: -0.1 }],
    ['an unknown raw chunk cost', { rawChunkCostUsd: null }],
  ])('ignores %s', (_label, input) => {
    expect(providerReportedCostUsd(input)).toBeNull();
  });
});

describe('resolveStepCost', () => {
  const step = {
    model: 'anthropic/claude-sonnet-5.5',
    inputTokens: 1_000,
    outputTokens: 200,
  };

  it('prefers the provider-reported cost over a price table', () => {
    expect(resolveStepCost({
      ...step,
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
    }, priceTable)).toEqual({ usd: 0.5, source: 'provider-reported', pricingVersion: null });
    expect(resolveStepCost({ ...step, rawChunkCostUsd: 0.25 }, priceTable))
      .toEqual({ usd: 0.25, source: 'provider-reported', pricingVersion: null });
  });

  it('estimates from the price table and names its version', () => {
    expect(resolveStepCost(step, priceTable)).toEqual({
      usd: 0.004,
      source: 'price-table',
      pricingVersion: 'openrouter-2026-10-04',
    });
  });

  it('keeps an unpriced model unknown, never zero', () => {
    expect(resolveStepCost({ ...step, model: 'openai/gpt-6.1-sol' }, priceTable))
      .toEqual(UNKNOWN_TURN_COST);
    expect(resolveStepCost(step)).toEqual(UNKNOWN_TURN_COST);
    expect(resolveStepCost({ ...step, model: null }, priceTable)).toEqual(UNKNOWN_TURN_COST);
  });

  it('never prices a model through an inherited object key', () => {
    expect(resolveStepCost({ ...step, model: 'constructor' }, priceTable))
      .toEqual(UNKNOWN_TURN_COST);
  });
});

describe('combineTurnCost', () => {
  const provider = { usd: 0.25, source: 'provider-reported' as const, pricingVersion: null };
  const table = { usd: 0.125, source: 'price-table' as const, pricingVersion: 'v1' };

  it('sums provider-reported steps', () => {
    expect(combineTurnCost([provider, provider]))
      .toEqual({ usd: 0.5, source: 'provider-reported', pricingVersion: null });
  });

  it('marks a turn with any estimated step as price-table', () => {
    expect(combineTurnCost([provider, table]))
      .toEqual({ usd: 0.375, source: 'price-table', pricingVersion: 'v1' });
  });

  it('keeps the turn unknown when one step is unknown or no step ran', () => {
    expect(combineTurnCost([provider, UNKNOWN_TURN_COST])).toEqual(UNKNOWN_TURN_COST);
    expect(combineTurnCost([])).toEqual(UNKNOWN_TURN_COST);
  });
});

describe('RuntimePriceTableSchema', () => {
  it('accepts a versioned table', () => {
    expect(RuntimePriceTableSchema.parse(priceTable)).toEqual(priceTable);
  });

  it.each([
    ['a version with spaces', { ...priceTable, version: 'october prices' }],
    ['a free-text model key', { ...priceTable, models: { 'my model': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } }],
    ['a negative price', { ...priceTable, models: { 'a/b': { inputUsdPerMillion: -1, outputUsdPerMillion: 1 } } }],
    ['an unknown field', { ...priceTable, currency: 'EUR' }],
  ])('rejects %s', (_label, value) => {
    expect(RuntimePriceTableSchema.safeParse(value).success).toBe(false);
  });
});
