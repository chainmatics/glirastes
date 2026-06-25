import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
