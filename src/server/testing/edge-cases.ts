import { describe, it, expect } from 'vitest';
import type { EdgeCaseTestOptions } from './types.js';
import {
  getArrayElement,
  getArrayMax,
  getBaseType,
  getEnumValues,
  getObjectShape,
  isOptional,
  isUuidString,
  unwrap,
} from './zod-introspect.js';

interface ZodSchema {
  safeParse: (input: unknown) => { success: boolean; error?: { issues: unknown[] } };
}

interface ToolWithSchema {
  inputSchema?: ZodSchema;
  [key: string]: unknown;
}

/**
 * Auto-generates edge case tests from tool Zod schemas + custom cases.
 *
 * For each tool with an `inputSchema`, introspects the Zod schema to generate
 * boundary tests for required fields, enums, arrays with limits, etc.
 */
export function runEdgeCaseTest(
  toolRegistry: Record<string, unknown>,
  options?: EdgeCaseTestOptions,
): void {
  const skipTools = new Set(options?.skipTools ?? []);
  const customCases = options?.customCases ?? {};

  const toolsWithSchemas = Object.entries(toolRegistry)
    .filter(([name]) => !skipTools.has(name))
    .filter(([, def]) => {
      const tool = def as ToolWithSchema;
      return tool.inputSchema && typeof tool.inputSchema.safeParse === 'function';
    }) as Array<[string, ToolWithSchema]>;

  if (toolsWithSchemas.length === 0 && Object.keys(customCases).length === 0) {
    return;
  }

  describe('AI Tool Edge Cases', () => {
    for (const [toolName, toolDef] of toolsWithSchemas) {
      const schema = toolDef.inputSchema!;
      const shape = getObjectShape(schema);
      const hasShapeTests = shape && hasTestableFields(shape);
      const custom = customCases[toolName];
      const hasCustom = custom && custom.length > 0;

      // Skip tools that would produce empty describe blocks
      if (!hasShapeTests && !hasCustom) continue;

      describe(toolName, () => {
        // Auto-generated from Zod schema
        if (shape && hasShapeTests) {
          describe('auto-generated schema boundaries', () => {
            generateShapeTests(shape, schema);
          });
        }

        // Custom business-logic cases
        if (hasCustom) {
          describe('custom business-logic', () => {
            for (const c of custom) {
              it(c.label, () => {
                const result = schema.safeParse(c.input);
                if (c.expectError) {
                  expect(
                    result.success,
                    `Expected validation error for: ${c.label}`,
                  ).toBe(false);
                } else {
                  expect(
                    result.success,
                    `Expected valid input for: ${c.label}${
                      !result.success ? ` — got: ${JSON.stringify((result as { error: { issues: unknown[] } }).error.issues)}` : ''
                    }`,
                  ).toBe(true);
                }
              });
            }
          });
        }
      });
    }

    // Custom cases for tools not in registry (still useful)
    for (const [toolName, custom] of Object.entries(customCases)) {
      if (toolsWithSchemas.some(([name]) => name === toolName)) continue;
      if (skipTools.has(toolName)) continue;

      const toolDef = toolRegistry[toolName] as ToolWithSchema | undefined;
      if (!toolDef?.inputSchema) continue;

      describe(toolName, () => {
        describe('custom business-logic', () => {
          for (const c of custom) {
            it(c.label, () => {
              const result = toolDef.inputSchema!.safeParse(c.input);
              if (c.expectError) {
                expect(result.success).toBe(false);
              } else {
                expect(result.success).toBe(true);
              }
            });
          }
        });
      });
    }
  });
}

// ── Zod Schema Introspection Helpers ──────────────────────────────────────

/**
 * Check if a shape has at least one field that would generate a test
 * (required field, enum, array with max, or string with UUID).
 */
function hasTestableFields(shape: Record<string, unknown>): boolean {
  for (const [, fieldSchema] of Object.entries(shape)) {
    if (!isOptional(fieldSchema)) return true; // Required field → "rejects missing" test

    const inner = unwrap(fieldSchema);
    const type = getBaseType(inner);
    if (type === 'enum' && getEnumValues(inner).length > 0) return true;
    if (type === 'array' && getArrayMax(inner) !== null) return true;
    if (type === 'string' && isUuidString(inner)) return true;
  }
  return false;
}

function generateShapeTests(
  shape: Record<string, unknown>,
  parentSchema: ZodSchema,
): void {
  // Build a valid base object with placeholder values
  const baseInput = buildMinimalValidInput(shape);

  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const optional = isOptional(fieldSchema);
    const inner = unwrap(fieldSchema);
    const type = getBaseType(inner);

    // Required field: test missing
    if (!optional) {
      it(`rejects missing ${fieldName} (required)`, () => {
        const input = { ...baseInput };
        delete input[fieldName];
        const result = parentSchema.safeParse(input);
        expect(result.success, `${fieldName} is required`).toBe(false);
      });
    }

    // Enum: test each valid value + invalid
    const enumValues = type === 'enum' ? getEnumValues(inner) : [];
    if (enumValues.length > 0) {
      for (const val of enumValues) {
        it(`accepts valid ${fieldName} enum: ${val}`, () => {
          const result = parentSchema.safeParse({ ...baseInput, [fieldName]: val });
          expect(result.success).toBe(true);
        });
      }
      it(`rejects invalid ${fieldName} enum: INVALID_VALUE`, () => {
        const result = parentSchema.safeParse({ ...baseInput, [fieldName]: 'INVALID_VALUE' });
        expect(result.success).toBe(false);
      });
    }

    // Array with max: test at limit and over limit
    if (type === 'array') {
      const max = getArrayMax(inner);
      if (max !== null) {
        const arrayFillValue = getArrayElementPlaceholder(inner);
        it(`accepts ${fieldName} at max(${max})`, () => {
          const result = parentSchema.safeParse({
            ...baseInput,
            [fieldName]: Array(max).fill(arrayFillValue),
          });
          expect(result.success).toBe(true);
        });
        it(`rejects ${fieldName} over max(${max})`, () => {
          const result = parentSchema.safeParse({
            ...baseInput,
            [fieldName]: Array(max + 1).fill(arrayFillValue),
          });
          expect(result.success).toBe(false);
        });
      }
    }

    // String with UUID check
    if (type === 'string' && isUuidString(inner)) {
      it(`rejects invalid ${fieldName} UUID: "not-a-uuid"`, () => {
        const result = parentSchema.safeParse({ ...baseInput, [fieldName]: 'not-a-uuid' });
        expect(result.success).toBe(false);
      });
    }
  }
}

function getArrayElementPlaceholder(arraySchema: unknown): unknown {
  const elementSchema = getArrayElement(arraySchema);
  if (elementSchema) {
    const elType = getBaseType(elementSchema);
    if (elType === 'string') {
      return isUuidString(elementSchema)
        ? '00000000-0000-0000-0000-000000000000'
        : 'test-id';
    }
    if (elType === 'number') return 1;
  }
  return 'test-id';
}

function buildMinimalValidInput(shape: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(shape)) {
    if (isOptional(schema)) continue;
    const inner = unwrap(schema);
    const type = getBaseType(inner);

    if (type === 'string') {
      input[name] = isUuidString(inner)
        ? '00000000-0000-0000-0000-000000000000'
        : 'test-value';
    } else if (type === 'number') {
      input[name] = 1;
    } else if (type === 'boolean') {
      input[name] = false;
    } else if (type === 'enum') {
      const values = getEnumValues(inner);
      input[name] = values.length > 0 ? values[0] : 'test';
    } else if (type === 'array') {
      // Introspect array element type to generate valid placeholders
      const elementSchema = getArrayElement(inner);
      if (elementSchema) {
        const elType = getBaseType(elementSchema);
        if (elType === 'string') {
          input[name] = isUuidString(elementSchema)
            ? ['00000000-0000-0000-0000-000000000000']
            : ['test-id'];
        } else if (elType === 'number') {
          input[name] = [1];
        } else {
          input[name] = ['test-id'];
        }
      } else {
        input[name] = ['test-id'];
      }
    } else {
      input[name] = 'test';
    }
  }
  return input;
}
