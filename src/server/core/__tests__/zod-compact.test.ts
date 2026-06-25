import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToCompactDescription } from '../zod-compact.js';

// ---------------------------------------------------------------------------
// Characterization tests for zodToCompactDescription.
//
// This function introspects Zod schemas to produce TypeScript-like description
// strings for AI tool prompts. It historically relied on Zod-v3 internals
// (`_def.typeName`, `def.shape()`, …). Under a Zod-v4 upgrade those internals
// change, and the function can silently fall through to "unknown" instead of
// throwing — so every primitive and combinator needs an explicit assertion on
// the OUTPUT, not just a passing build.
// ---------------------------------------------------------------------------

describe('zodToCompactDescription', () => {
  describe('primitives', () => {
    it('describes string / number / boolean', () => {
      expect(zodToCompactDescription(z.string())).toBe('string');
      expect(zodToCompactDescription(z.number())).toBe('number');
      expect(zodToCompactDescription(z.boolean())).toBe('boolean');
    });

    it('serializes dates as string (JSON wire shape)', () => {
      expect(zodToCompactDescription(z.date())).toBe('string');
    });

    it('describes null / any / unknown', () => {
      expect(zodToCompactDescription(z.null())).toBe('null');
      expect(zodToCompactDescription(z.any())).toBe('any');
      expect(zodToCompactDescription(z.unknown())).toBe('unknown');
    });

    it('describes literals via JSON.stringify', () => {
      expect(zodToCompactDescription(z.literal('done'))).toBe('"done"');
      expect(zodToCompactDescription(z.literal(42))).toBe('42');
    });
  });

  describe('enums', () => {
    it('describes a string enum as a union of quoted members', () => {
      expect(zodToCompactDescription(z.enum(['open', 'closed']))).toBe(
        '"open" | "closed"',
      );
    });
  });

  describe('arrays', () => {
    it('describes arrays of primitives', () => {
      expect(zodToCompactDescription(z.array(z.string()))).toBe(
        'Array<string>',
      );
    });

    it('describes arrays of objects', () => {
      expect(
        zodToCompactDescription(z.array(z.object({ id: z.string() }))),
      ).toBe('Array<{ id: string }>');
    });
  });

  describe('records / unions / tuples', () => {
    it('describes a record', () => {
      expect(zodToCompactDescription(z.record(z.string(), z.number()))).toBe(
        'Record<string, number>',
      );
    });

    it('describes a union', () => {
      expect(
        zodToCompactDescription(z.union([z.string(), z.number()])),
      ).toBe('string | number');
    });

    it('describes a tuple', () => {
      expect(
        zodToCompactDescription(z.tuple([z.string(), z.number()])),
      ).toBe('[string, number]');
    });
  });

  describe('objects and field modifiers', () => {
    it('describes a flat object', () => {
      expect(
        zodToCompactDescription(
          z.object({ id: z.string(), total: z.number() }),
        ),
      ).toBe('{ id: string, total: number }');
    });

    it('describes the empty object as {}', () => {
      expect(zodToCompactDescription(z.object({}))).toBe('{}');
    });

    it('marks optional fields with ?', () => {
      expect(
        zodToCompactDescription(z.object({ note: z.string().optional() })),
      ).toBe('{ note?: string }');
    });

    it('marks default fields as optional', () => {
      expect(
        zodToCompactDescription(z.object({ page: z.number().default(1) })),
      ).toBe('{ page?: number }');
    });

    it('appends | null for nullable fields', () => {
      expect(
        zodToCompactDescription(z.object({ deletedAt: z.string().nullable() })),
      ).toBe('{ deletedAt: string | null }');
    });

    it('handles nullable + optional together', () => {
      expect(
        zodToCompactDescription(
          z.object({ x: z.string().nullable().optional() }),
        ),
      ).toBe('{ x?: string | null }');
    });
  });

  describe('nesting and depth', () => {
    it('describes a nested example, collapsing past default maxDepth=3', () => {
      const schema = z.object({
        tasks: z.array(z.object({ id: z.string(), title: z.string() })),
        total: z.number(),
      });
      // root(0) -> array(1) -> inner object(2) -> its fields(3) collapse to "..."
      expect(zodToCompactDescription(schema)).toBe(
        '{ tasks: Array<{ id: ..., title: ... }>, total: number }',
      );
    });

    it('keeps nested fields visible when maxDepth is raised', () => {
      const schema = z.object({
        tasks: z.array(z.object({ id: z.string(), title: z.string() })),
        total: z.number(),
      });
      expect(zodToCompactDescription(schema, 5)).toBe(
        '{ tasks: Array<{ id: string, title: string }>, total: number }',
      );
    });

    it('collapses to ... beyond maxDepth', () => {
      const deep = z.object({
        a: z.object({ b: z.object({ c: z.object({ d: z.string() }) }) }),
      });
      // depth 0 {a} -> depth 1 {b} -> depth 2 {c} -> depth 3 collapses
      expect(zodToCompactDescription(deep)).toBe(
        '{ a: { b: { c: ... } } }',
      );
    });
  });
});
