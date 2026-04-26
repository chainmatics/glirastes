import { describe, it, expect } from 'vitest';
import type { SchemaConsistencyOptions } from './types.js';

interface ZodSchema {
  _def: {
    typeName: string;
    shape?: () => Record<string, ZodSchema>;
    type?: ZodSchema;
    innerType?: ZodSchema;
    checks?: Array<{ kind: string }>;
  };
}

interface ToolWithSchema {
  inputSchema?: ZodSchema;
  [key: string]: unknown;
}

/**
 * Verifies that tool output field types match the input field types
 * of downstream tools in declared workflow chains.
 */
export function runSchemaConsistencyTest(
  toolRegistry: Record<string, unknown>,
  options: SchemaConsistencyOptions,
): void {
  if (options.chains.length === 0) return;

  describe('AI Tool Schema Consistency', () => {
    for (const chain of options.chains) {
      const label = `${chain.from}.${chain.field} → ${chain.to}.${chain.targetField}`;

      it(label, () => {
        // Both tools must exist
        const fromTool = toolRegistry[chain.from] as ToolWithSchema | undefined;
        const toTool = toolRegistry[chain.to] as ToolWithSchema | undefined;

        expect(fromTool, `Source tool "${chain.from}" not in registry`).toBeDefined();
        expect(toTool, `Target tool "${chain.to}" not in registry`).toBeDefined();

        // Target tool must have inputSchema with the target field
        const toSchema = toTool!.inputSchema;
        expect(
          toSchema,
          `Target tool "${chain.to}" has no inputSchema`,
        ).toBeDefined();

        const toShape = getShape(toSchema!);
        expect(
          toShape,
          `Target tool "${chain.to}" inputSchema is not an object`,
        ).not.toBeNull();

        const targetField = resolveField(toShape!, chain.targetField);
        expect(
          targetField,
          `Target field "${chain.targetField}" not found in ${chain.to} inputSchema`,
        ).not.toBeNull();

        // Verify type compatibility
        const targetType = getBaseTypeName(targetField!);
        expect(
          ['ZodString', 'ZodNumber', 'ZodArray', 'ZodEnum', 'ZodBoolean'].includes(targetType),
          `Target field "${chain.targetField}" in ${chain.to} has unrecognized type: ${targetType}`,
        ).toBe(true);
      });
    }
  });
}

function getShape(schema: ZodSchema): Record<string, ZodSchema> | null {
  const def = schema._def;
  if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
    return def.shape();
  }
  if ((def.typeName === 'ZodEffects' || def.typeName === 'ZodOptional') && def.innerType) {
    return getShape(def.innerType);
  }
  return null;
}

function resolveField(shape: Record<string, ZodSchema>, path: string): ZodSchema | null {
  if (shape[path]) return shape[path];
  return null;
}

function getBaseTypeName(schema: ZodSchema): string {
  const def = schema._def;
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable' || def.typeName === 'ZodDefault') {
    return def.innerType ? getBaseTypeName(def.innerType) : def.typeName;
  }
  return def.typeName;
}
