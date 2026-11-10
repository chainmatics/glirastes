import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agenticContentProblem,
  lockDigest,
  MAX_AGENTIC_SCHEMA_BYTES,
  strictSchemaProblem,
  withoutMetaSchema,
} from './agentic.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false });

describe('agentic content gate', () => {
  it.each([
    ['a bearer token', { hint: `Bearer ${'a'.repeat(24)}` }, 'secret-looking content'],
    ['a short provider key prefix', { example: 'use sk-or-v1-abc' }, 'a provider key prefix (sk-or-v1)'],
    ['a provider key prefix in a key', { 'sk-or-v1': 'x' }, 'a provider key prefix (sk-or-v1)'],
    ['a control character', { title: 'Tasks\u0007' }, 'control characters'],
  ])('refuses %s anywhere', (_label, value, reason) => {
    expect(agenticContentProblem(value)).toBe(reason);
  });

  it('refuses e-mail addresses and long numbers in prose only', () => {
    const business = 'what looks like business data (an e-mail address or a long number)';
    expect(agenticContentProblem({ examples: ['Schreib anna.meier@kunde.de an'] }, { prose: true })).toBe(business);
    expect(agenticContentProblem({ examples: ['Ruf 0151 2345 6789 an'] }, { prose: true })).toBe(business);
    expect(agenticContentProblem({ input: { id: '019fb900-0000-7000-8000-000000000001' } })).toBeUndefined();
    expect(agenticContentProblem({ examples: ['Zeig die Aufgaben vom 2026-10-05'] }, { prose: true })).toBeUndefined();
  });
});

describe('strict agentic JSON Schema', () => {
  it('accepts what Zod v4 emits, tuples and formats included', () => {
    const emitted = z.toJSONSchema(z.object({
      pair: z.tuple([z.string(), z.number()]),
      due: z.iso.datetime().optional(),
      status: z.enum(['open', 'done']),
    }).strict()) as Record<string, unknown>;
    expect(strictSchemaProblem(withoutMetaSchema(emitted), 'input')).toBeUndefined();
  });

  it.each([
    ['an unknown keyword', object({ title: { type: 'string', looksLike: 'x' } }), 'not valid strict JSON Schema'],
    ['a non-object input', { type: 'string' }, 'must be an object with additionalProperties false'],
    ['open additional properties', { type: 'object', properties: {} }, 'must be an object with additionalProperties false'],
    ['pattern-matched keys', { ...object({}), patternProperties: { '^x-': { type: 'string' } } }, 'may not use patternProperties'],
    ['constrained key names', { ...object({}), propertyNames: { pattern: '^a' } }, 'may not use propertyNames'],
    ['an oversized schema', object({ title: { description: 'x'.repeat(MAX_AGENTIC_SCHEMA_BYTES) } }), 'exceeds 32 KB'],
  ])('refuses %s as input', (_label, schema, reason) => {
    expect(strictSchemaProblem(schema, 'input')).toContain(reason);
  });

  it('allows any strict output shape', () => {
    expect(strictSchemaProblem({ type: 'array', items: object({ id: { type: 'string' } }) }, 'output')).toBeUndefined();
    expect(strictSchemaProblem({ type: 'array', itemz: {} }, 'output')).toContain('not valid strict JSON Schema');
  });

  it('pins reviewed values independent of key order', () => {
    expect(lockDigest({ a: 1, b: [2] })).toBe(lockDigest({ b: [2], a: 1 }));
    expect(lockDigest({ a: 1 })).not.toBe(lockDigest({ a: 2 }));
    expect(lockDigest('x')).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });
});
