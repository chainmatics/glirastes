import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_METRIC_MAX_BATCH,
  RUNTIME_METRIC_MAX_TOOLS,
  RuntimeMetricEventSchema,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventSchema,
  TechnicalRuntimeEventV2Schema,
  ToolContractRejectedEventSchema,
} from '../index.js';

interface VectorSet {
  base: Record<string, unknown>;
  valid: Array<{ name: string; patch: Record<string, unknown> }>;
  invalid: Array<{ name: string; patch: Record<string, unknown> }>;
}

interface MetricEventVectors extends VectorSet {
  schemaVersion: 2;
  toolContractRejected: VectorSet;
}

/**
 * The Platform keeps a byte-identical copy (`apps/api/src/modules/
 * runtime-metrics/__vectors__/`) and pins the same digest. Changing a vector
 * means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '114521143ea6d65564a2b4dc70318a7d30ef8cbc2cfdb4f87e7101b786558d17';
const raw = readFileSync(
  new URL('../__vectors__/runtime-metric-event.v2.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as MetricEventVectors;

const eventOf = (patch: Record<string, unknown>) => ({ ...vectors.base, ...patch });

describe('TechnicalRuntimeEvent v2 golden vectors', () => {
  it('pins the vectors the Platform copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
  });

  it('names every vector uniquely and covers both outcomes', () => {
    const names = [...vectors.valid, ...vectors.invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    expect(vectors.valid).toHaveLength(10);
    expect(vectors.invalid).toHaveLength(31);
  });

  it.each(vectors.valid.map((vector) => [vector.name, vector.patch] as const))(
    'accepts %s',
    (_name, patch) => {
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(true);
    },
  );

  it.each(vectors.invalid.map((vector) => [vector.name, vector.patch] as const))(
    'rejects %s',
    (_name, patch) => {
      expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf(patch)).success).toBe(false);
    },
  );
});

describe('tool_contract_rejected golden vectors (spec 4.7)', () => {
  const set = vectors.toolContractRejected;
  const rejectionOf = (patch: Record<string, unknown>) => ({ ...set.base, ...patch });

  it('names every vector uniquely and covers both outcomes', () => {
    const names = [...set.valid, ...set.invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    expect(set.valid).toHaveLength(4);
    expect(set.invalid).toHaveLength(12);
  });

  it.each(set.valid.map((vector) => [vector.name, vector.patch] as const))('accepts %s', (_name, patch) => {
    expect(ToolContractRejectedEventSchema.safeParse(rejectionOf(patch)).success).toBe(true);
    expect(RuntimeMetricEventSchema.safeParse(rejectionOf(patch)).success).toBe(true);
  });

  it.each(set.invalid.map((vector) => [vector.name, vector.patch] as const))('rejects %s', (_name, patch) => {
    expect(RuntimeMetricEventSchema.safeParse(rejectionOf(patch)).success).toBe(false);
  });

  it('keeps every turn vector valid in the union and batches one event type at a time', () => {
    for (const vector of vectors.valid) {
      expect(RuntimeMetricEventSchema.safeParse(eventOf(vector.patch)).success).toBe(true);
    }
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [set.base, set.base] }).success).toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [vectors.base, set.base] }).success).toBe(false);
  });
});

describe('TechnicalRuntimeEvent v2 limits', () => {
  const tool = (index: number) => ({
    toolId: `019fb900-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
    calls: 1,
    errors: 0,
  });

  it('lists at most 32 distinct tools per turn', () => {
    const tools = Array.from({ length: RUNTIME_METRIC_MAX_TOOLS + 1 }, (_, index) => tool(index + 1));
    expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf({
      toolCallCount: tools.length,
      toolErrorCount: 0,
      tools: tools.slice(0, RUNTIME_METRIC_MAX_TOOLS),
    })).success).toBe(true);
    expect(TechnicalRuntimeEventV2Schema.safeParse(eventOf({
      toolCallCount: tools.length,
      toolErrorCount: 0,
      tools,
    })).success).toBe(false);
  });

  it('batches between 1 and 50 events of the same schema version', () => {
    const events = Array.from({ length: RUNTIME_METRIC_MAX_BATCH }, () => vectors.base);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events }).success)
      .toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [] }).success)
      .toBe(false);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({
      schemaVersion: 2,
      events: [...events, vectors.base],
    }).success).toBe(false);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({
      schemaVersion: 2,
      events: [vectors.base],
      tenantId: '019fb900-0000-7000-8000-0000000000f1',
    }).success).toBe(false);
  });

  it('keeps the v1 event contract unchanged', () => {
    expect(TechnicalRuntimeEventSchema.safeParse({
      eventId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3930',
      occurredAt: '2026-07-28T20:00:00.000Z',
      eventType: 'run.completed',
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3931',
      targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3932',
      environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3933',
      runId: 'run-1',
      status: 'completed',
    }).success).toBe(true);
  });
});
