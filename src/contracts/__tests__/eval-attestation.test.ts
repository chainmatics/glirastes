import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVAL_ATTESTATION_SCHEMA_VERSION,
  EvalAttestationRequestSchema,
} from '../index.js';

interface EvalAttestationVectors {
  contract: 'EvalAttestationRequest';
  schemaVersion: 1;
  valid: Array<{ name: string; body: Record<string, unknown> }>;
  invalid: Array<{ name: string; body: Record<string, unknown> }>;
}

const vectors = JSON.parse(
  readFileSync(new URL('../__vectors__/eval-attestation.v1.json', import.meta.url), 'utf8'),
) as EvalAttestationVectors;

describe('eval attestation request v1 vectors', () => {
  it('names the schema version the vector pins', () => {
    expect(vectors.contract).toBe('EvalAttestationRequest');
    expect(vectors.schemaVersion).toBe(EVAL_ATTESTATION_SCHEMA_VERSION);
  });

  it.each(vectors.valid.map((vector) => [vector.name, vector] as const))('accepts %s unchanged', (_name, vector) => {
    expect(EvalAttestationRequestSchema.parse(vector.body)).toEqual(vector.body);
  });

  it.each(vectors.invalid.map((vector) => [vector.name, vector] as const))('rejects %s', (_name, vector) => {
    expect(EvalAttestationRequestSchema.safeParse(vector.body).success).toBe(false);
  });
});
