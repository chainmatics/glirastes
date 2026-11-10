import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod-v3';
import { createJsonSchemaLike } from '../../../runtime/json-schema.js';
import {
  getArrayElement,
  getArrayMax,
  getBaseType,
  getEnumValues,
  getObjectShape,
  getSchemaType,
  hasStringFormat,
  isOptional,
  isUuidString,
  unwrap,
} from '../zod-introspect.js';

// These tests pin the Zod-internals introspection used by the test-suite
// generators. They exist so a Zod upgrade that changes the internal `_zod.def`
// shape fails loudly here, instead of silently producing empty test suites.

describe('zod-introspect', () => {
  describe('generated JSON schemas', () => {
    it('reads fields, required state, enums, arrays, and formats', () => {
      const schema = createJsonSchemaLike({
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          state: { type: 'string', enum: ['open', 'closed'] },
          tags: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 3,
          },
        },
        required: ['id', 'tags'],
      });
      const shape = getObjectShape(schema);

      expect(shape).not.toBeNull();
      expect(getBaseType(shape?.id)).toBe('string');
      expect(isUuidString(shape?.id)).toBe(true);
      expect(isOptional(shape?.id)).toBe(false);
      expect(isOptional(shape?.state)).toBe(true);
      expect(getEnumValues(shape?.state)).toEqual(['open', 'closed']);
      expect(getBaseType(shape?.tags)).toBe('array');
      expect(getSchemaType(getArrayElement(shape?.tags))).toBe('string');
      expect(getArrayMax(shape?.tags)).toBe(3);
    });
  });

  describe('Zod 3 host schemas', () => {
    it('reads objects, wrappers, enums, arrays, and constraints', () => {
      const schema = z3.object({
        id: z3.string().uuid(),
        state: z3.enum(['open', 'closed']).optional(),
        tags: z3.array(z3.string()).max(3),
      });
      const shape = getObjectShape(schema);

      expect(shape).not.toBeNull();
      expect(getBaseType(shape?.id)).toBe('string');
      expect(isUuidString(shape?.id)).toBe(true);
      expect(isOptional(shape?.state)).toBe(true);
      expect(getEnumValues(shape?.state)).toEqual(['open', 'closed']);
      expect(getBaseType(shape?.tags)).toBe('array');
      expect(getArrayMax(shape?.tags)).toBe(3);
    });
  });

  describe('getSchemaType', () => {
    it('reports base type tags', () => {
      expect(getSchemaType(z.string())).toBe('string');
      expect(getSchemaType(z.number())).toBe('number');
      expect(getSchemaType(z.boolean())).toBe('boolean');
      expect(getSchemaType(z.object({}))).toBe('object');
      expect(getSchemaType(z.array(z.string()))).toBe('array');
      expect(getSchemaType(z.enum(['a', 'b']))).toBe('enum');
      expect(getSchemaType(z.string().optional())).toBe('optional');
    });
  });

  describe('isOptional', () => {
    it('detects optional, default, and nullable', () => {
      expect(isOptional(z.string())).toBe(false);
      expect(isOptional(z.string().optional())).toBe(true);
      expect(isOptional(z.number().default(1))).toBe(true);
      expect(isOptional(z.string().nullable())).toBe(true);
    });
  });

  describe('unwrap / getBaseType', () => {
    it('strips optional/nullable/default to the base type', () => {
      expect(getBaseType(z.string().optional())).toBe('string');
      expect(getBaseType(z.number().nullable().optional())).toBe('number');
      expect(getBaseType(z.enum(['a']).default('a'))).toBe('enum');
    });

    it('strips transforms (pipes)', () => {
      expect(getBaseType(z.string().transform((s) => s))).toBe('string');
      expect(getSchemaType(unwrap(z.string().trim()))).toBe('string');
    });
  });

  describe('getObjectShape', () => {
    it('returns the field map of an object', () => {
      const shape = getObjectShape(
        z.object({ id: z.string(), n: z.number() }),
      );
      expect(shape).not.toBeNull();
      expect(Object.keys(shape!)).toEqual(['id', 'n']);
    });

    it('unwraps optional objects', () => {
      const shape = getObjectShape(z.object({ id: z.string() }).optional());
      expect(Object.keys(shape!)).toEqual(['id']);
    });

    it('returns null for non-objects', () => {
      expect(getObjectShape(z.string())).toBeNull();
      expect(getObjectShape(z.array(z.string()))).toBeNull();
    });
  });

  describe('getEnumValues', () => {
    it('returns the string members', () => {
      expect(getEnumValues(z.enum(['open', 'closed']))).toEqual([
        'open',
        'closed',
      ]);
    });

    it('unwraps before reading', () => {
      expect(getEnumValues(z.enum(['a', 'b']).optional())).toEqual(['a', 'b']);
    });

    it('returns [] for non-enums', () => {
      expect(getEnumValues(z.string())).toEqual([]);
    });
  });

  describe('arrays', () => {
    it('reads the element schema', () => {
      const el = getArrayElement(z.array(z.number()));
      expect(getSchemaType(el)).toBe('number');
    });

    it('reads the .max() constraint', () => {
      expect(getArrayMax(z.array(z.string()).max(3))).toBe(3);
    });

    it('returns null when there is no max', () => {
      expect(getArrayMax(z.array(z.string()))).toBeNull();
      expect(getArrayMax(z.string())).toBeNull();
    });
  });

  describe('string formats', () => {
    it('detects uuid', () => {
      expect(isUuidString(z.string().uuid())).toBe(true);
      expect(isUuidString(z.string())).toBe(false);
    });

    it('detects other formats via hasStringFormat', () => {
      expect(hasStringFormat(z.string().email(), 'email')).toBe(true);
      expect(hasStringFormat(z.string().uuid(), 'email')).toBe(false);
    });

    it('unwraps before reading the format', () => {
      expect(isUuidString(z.string().uuid().optional())).toBe(true);
    });
  });
});
