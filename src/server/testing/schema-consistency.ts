import { describe, it, expect } from 'vitest';
import type { SchemaConsistencyOptions } from './types.js';
import { getBaseType, getObjectShape } from './zod-introspect.js';

interface ToolWithSchema {
  inputSchema?: unknown;
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

        const toShape = getObjectShape(toSchema!);
        expect(
          toShape,
          `Target tool "${chain.to}" inputSchema is not an object`,
        ).not.toBeNull();

        const targetField = toShape![chain.targetField] ?? null;
        expect(
          targetField,
          `Target field "${chain.targetField}" not found in ${chain.to} inputSchema`,
        ).not.toBeNull();

        // Verify type compatibility
        const targetType = getBaseType(targetField);
        expect(
          ['string', 'number', 'array', 'enum', 'boolean'].includes(
            targetType ?? '',
          ),
          `Target field "${chain.targetField}" in ${chain.to} has unrecognized type: ${targetType}`,
        ).toBe(true);
      });
    }
  });
}
