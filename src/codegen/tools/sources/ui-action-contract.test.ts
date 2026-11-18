import { describe, expect, it } from 'vitest';
import { payloadContradiction, probedPayload } from './ui-action-contract.js';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

describe('payloadContradiction', () => {
  it('accepts what only the zod side states: formats, bounds, integer for number, an open TypeScript type', () => {
    expect(payloadContradiction(
      object({
        id: { type: 'string', format: 'uuid', description: 'Id' },
        n: { type: 'integer', minimum: 1 },
        at: {},
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
      }, ['id', 'n']),
      object({
        id: { type: 'string' },
        n: { type: 'number' },
        at: { type: 'string', format: 'date-time' },
        maybe: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        tags: { type: 'array', items: { type: 'string' } },
      }, ['id', 'n']),
    )).toBeUndefined();
  });

  it('names the path of a different type, enum, property set or required set, never a value', () => {
    expect(payloadContradiction(object({ id: { type: 'string' } }, ['id']), object({ id: { type: 'number' } }, ['id'])))
      .toBe('id has a different type');
    expect(payloadContradiction(
      object({ kind: { type: 'string', enum: ['a', 'secretValue'] } }),
      object({ kind: { type: 'string', enum: ['a'] } }),
    )).toBe('kind allows different values');
    expect(payloadContradiction(object({ a: { type: 'string' } }), object({ b: { type: 'string' } })))
      .toBe('a, b exists on one side only');
    expect(payloadContradiction(object({ a: { type: 'string' } }, ['a']), object({ a: { type: 'string' } })))
      .toBe('a is required on one side only');
    expect(payloadContradiction(
      object({ filter: object({ ids: { type: 'array', items: { type: 'string' } } }) }),
      object({ filter: object({ ids: { type: 'array', items: { type: 'number' } } }) }),
    )).toBe('filter.ids[] has a different type');
  });
});

describe('probedPayload', () => {
  const schema = (jsonSchema: Record<string, unknown> | null) => ({
    ok: true as const, kind: 'schema' as const, digest: 'sha256:x', jsonSchema, description: null,
  });

  it('closes the top level unless the contract declares extra keys', () => {
    expect(probedPayload(schema({ type: 'object', properties: {} })))
      .toEqual({ ok: true, schema: { type: 'object', properties: {}, additionalProperties: false } });
    expect(probedPayload(schema({ type: 'object', properties: {}, additionalProperties: {} })))
      .toEqual({ ok: true, schema: { type: 'object', properties: {}, additionalProperties: {} } });
  });

  it('refuses failures, missing JSON Schema, non-object and uncompilable schemas', () => {
    expect(probedPayload({ ok: false, reason: 'timeout' })).toEqual({ ok: false, reason: 'timeout' });
    expect(probedPayload(schema(null))).toMatchObject({ ok: false, reason: expect.stringContaining('no JSON Schema') });
    expect(probedPayload(schema({ type: 'string' }))).toEqual({ ok: false, reason: 'not an object schema' });
    expect(probedPayload(schema({ type: 'object', properties: { a: { type: 'string', pattern: '(' } } })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('cannot compile') });
  });
});
