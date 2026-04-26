import { describe, it, expect } from 'vitest';
import type { EdgeCaseTestOptions } from './types.js';

interface ZodDef {
  typeName: string;
  checks?: Array<{ kind: string; value?: unknown }>;
  type?: ZodSchema;
  options?: ZodSchema[];
  values?: unknown[];
  innerType?: ZodSchema;
  shape?: () => Record<string, ZodSchema>;
}

interface ZodSchema {
  _def: ZodDef;
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
function hasTestableFields(shape: Record<string, ZodSchema>): boolean {
  for (const [, fieldSchema] of Object.entries(shape)) {
    const optional = isOptional(fieldSchema);
    if (!optional) return true; // Required field → generates "rejects missing" test

    const inner = unwrap(fieldSchema);
    const typeName = inner._def.typeName;
    if (typeName === 'ZodEnum' && inner._def.values) return true;
    if (typeName === 'ZodArray') {
      const checks = inner._def.checks ?? [];
      if (checks.some((c: { kind: string }) => c.kind === 'max')) return true;
    }
    if (typeName === 'ZodString') {
      const checks = inner._def.checks ?? [];
      if (checks.some((c: { kind: string }) => c.kind === 'uuid')) return true;
    }
  }
  return false;
}

function getObjectShape(schema: ZodSchema): Record<string, ZodSchema> | null {
  const def = schema._def;

  if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
    return def.shape();
  }

  // Unwrap ZodEffects (e.g. .refine(), .transform())
  if (def.typeName === 'ZodEffects' && def.innerType) {
    return getObjectShape(def.innerType);
  }

  return null;
}

function isOptional(schema: ZodSchema): boolean {
  const name = schema._def.typeName;
  return name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodDefault';
}

function unwrap(schema: ZodSchema): ZodSchema {
  const name = schema._def.typeName;
  if (
    (name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodDefault') &&
    schema._def.innerType
  ) {
    return unwrap(schema._def.innerType);
  }
  if (name === 'ZodEffects' && schema._def.innerType) {
    return unwrap(schema._def.innerType);
  }
  return schema;
}

function generateShapeTests(
  shape: Record<string, ZodSchema>,
  parentSchema: ZodSchema,
): void {
  // Build a valid base object with placeholder values
  const baseInput = buildMinimalValidInput(shape);

  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const optional = isOptional(fieldSchema);
    const inner = unwrap(fieldSchema);
    const typeName = inner._def.typeName;

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
    if (typeName === 'ZodEnum' && inner._def.values) {
      const values = inner._def.values as string[];
      for (const val of values) {
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
    if (typeName === 'ZodArray') {
      const checks = inner._def.checks ?? [];
      const maxCheck = checks.find((c: { kind: string }) => c.kind === 'max');
      if (maxCheck && typeof maxCheck.value === 'number') {
        const max = maxCheck.value as number;
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
    if (typeName === 'ZodString') {
      const checks = inner._def.checks ?? [];
      const hasUuid = checks.some((c: { kind: string }) => c.kind === 'uuid');
      if (hasUuid) {
        it(`rejects invalid ${fieldName} UUID: "not-a-uuid"`, () => {
          const result = parentSchema.safeParse({ ...baseInput, [fieldName]: 'not-a-uuid' });
          expect(result.success).toBe(false);
        });
      }
    }
  }
}

function getArrayElementPlaceholder(arraySchema: ZodSchema): unknown {
  const elementSchema = arraySchema._def.type;
  if (elementSchema) {
    const elInner = unwrap(elementSchema);
    const elType = elInner._def.typeName;
    if (elType === 'ZodString') {
      const elChecks = elInner._def.checks ?? [];
      if (elChecks.some((c: { kind: string }) => c.kind === 'uuid')) {
        return '00000000-0000-0000-0000-000000000000';
      }
      return 'test-id';
    }
    if (elType === 'ZodNumber') return 1;
  }
  return 'test-id';
}

function buildMinimalValidInput(shape: Record<string, ZodSchema>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(shape)) {
    if (isOptional(schema)) continue;
    const inner = unwrap(schema);
    const typeName = inner._def.typeName;

    if (typeName === 'ZodString') {
      const checks = inner._def.checks ?? [];
      if (checks.some((c: { kind: string }) => c.kind === 'uuid')) {
        input[name] = '00000000-0000-0000-0000-000000000000';
      } else {
        input[name] = 'test-value';
      }
    } else if (typeName === 'ZodNumber') {
      input[name] = 1;
    } else if (typeName === 'ZodBoolean') {
      input[name] = false;
    } else if (typeName === 'ZodEnum' && inner._def.values) {
      input[name] = (inner._def.values as string[])[0];
    } else if (typeName === 'ZodArray') {
      // Introspect array element type to generate valid placeholders
      const elementSchema = inner._def.type;
      if (elementSchema) {
        const elInner = unwrap(elementSchema);
        const elType = elInner._def.typeName;
        if (elType === 'ZodString') {
          const elChecks = elInner._def.checks ?? [];
          if (elChecks.some((c: { kind: string }) => c.kind === 'uuid')) {
            input[name] = ['00000000-0000-0000-0000-000000000000'];
          } else {
            input[name] = ['test-id'];
          }
        } else if (elType === 'ZodNumber') {
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
