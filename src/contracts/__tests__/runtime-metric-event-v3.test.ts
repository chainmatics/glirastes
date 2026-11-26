import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION_V3,
  RuntimeMetricEventSchema,
  TechnicalRuntimeEventBatchSchema,
  TechnicalRuntimeEventV2Schema,
  TechnicalRuntimeEventV3Schema,
  TurnContinuedEventV3Schema,
} from '../index.js';

interface MetricEventV3Vectors {
  schemaVersion: 3;
  absentMarker: string;
  base: Record<string, unknown>;
  valid: Array<{ name: string; patch: Record<string, unknown> }>;
  invalid: Array<{ name: string; patch: Record<string, unknown> }>;
}

/**
 * The Platform keeps a byte-identical copy (T15) and pins the same digest.
 * Changing a vector means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '50e9020aae74f5937056718c5a53de7852217e8d83fa92ee835683e63226a6b5';
const raw = readFileSync(new URL('../__vectors__/runtime-metric-event.v3.json', import.meta.url));
const vectors = JSON.parse(raw.toString('utf8')) as MetricEventV3Vectors;

const eventOf = (patch: Record<string, unknown>) => Object.fromEntries(
  Object.entries({ ...vectors.base, ...patch }).filter(([, value]) => value !== vectors.absentMarker),
);
const schemaOf = (event: Record<string, unknown>) => (
  event.eventType === 'turn.continued' ? TurnContinuedEventV3Schema : TechnicalRuntimeEventV3Schema
);

describe('TechnicalRuntimeEvent v3 golden vectors', () => {
  it('pins the vectors the Platform copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.schemaVersion).toBe(RUNTIME_METRIC_EVENT_SCHEMA_VERSION_V3);
    const names = [...vectors.valid, ...vectors.invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(vectors.valid.map((vector) => [vector.name, vector.patch] as const))('accepts %s', (_name, patch) => {
    const event = eventOf(patch);
    expect(schemaOf(event).safeParse(event).success).toBe(true);
    expect(RuntimeMetricEventSchema.safeParse(event).success).toBe(true);
  });

  it.each(vectors.invalid.map((vector) => [vector.name, vector.patch] as const))('rejects %s', (_name, patch) => {
    const event = eventOf(patch);
    expect(schemaOf(event).safeParse(event).success).toBe(false);
    expect(RuntimeMetricEventSchema.safeParse(event).success).toBe(false);
  });

  it('is v2 plus deploymentId, cohort, approvalsRequested and approvalsDeclined', () => {
    const {
      deploymentId: _deploymentId, cohort: _cohort, approvalsRequested: _requested, approvalsDeclined: _declined, ...v2
    } = vectors.base;
    expect(TechnicalRuntimeEventV2Schema.safeParse({ ...v2, schemaVersion: 2 }).success).toBe(true);
  });

  it('batches v3 turn events under schema version 3 only', () => {
    const finished = eventOf({});
    const continued = eventOf(vectors.valid.find((vector) => vector.patch.eventType === 'turn.continued')!.patch);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 3, events: [finished, finished] }).success).toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 3, events: [continued] }).success).toBe(true);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [finished] }).success).toBe(false);
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 3, events: [finished, continued] }).success).toBe(false);
    const { deploymentId: _d, cohort: _c, approvalsRequested: _r, approvalsDeclined: _a, ...v2 } = finished;
    expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 3, events: [{ ...v2, schemaVersion: 2 }] }).success)
      .toBe(false);
  });
});
