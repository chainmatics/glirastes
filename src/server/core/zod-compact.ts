import { z } from 'zod';

/**
 * Convert a Zod schema to a compact TypeScript-like description string.
 *
 * Used to auto-generate "Returns: ..." suffixes for AI tool descriptions,
 * so the LLM knows the response shape without bloating the system prompt.
 *
 * @example
 * zodToCompactDescription(z.object({
 *   tasks: z.array(z.object({ id: z.string(), title: z.string() })),
 *   total: z.number(),
 * }))
 * // → '{ tasks: Array<{ id: string, title: string }>, total: number }'
 *
 * @param schema - Any Zod schema
 * @param maxDepth - Maximum nesting depth before collapsing to "..." (default: 3)
 */
export function zodToCompactDescription(
  schema: z.ZodTypeAny,
  maxDepth = 3,
): string {
  return describeSchema(schema, 0, maxDepth);
}

function describeSchema(
  schema: z.ZodTypeAny,
  depth: number,
  maxDepth: number,
): string {
  if (depth >= maxDepth) return '...';

  const def = (schema as any)._def;
  const typeName = def?.typeName as string | undefined;

  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodDate':
      return 'string'; // Dates serialize as strings in JSON
    case 'ZodLiteral':
      return JSON.stringify(def.value);
    case 'ZodNull':
      return 'null';
    case 'ZodUndefined':
      return 'undefined';
    case 'ZodAny':
      return 'any';
    case 'ZodUnknown':
      return 'unknown';
    case 'ZodVoid':
      return 'void';

    case 'ZodEnum':
      return (def.values as string[])
        .map((v: string) => `"${v}"`)
        .join(' | ');

    case 'ZodNativeEnum':
      return Object.values(def.values as Record<string, string | number>)
        .filter((v): v is string => typeof v === 'string')
        .map((v) => `"${v}"`)
        .join(' | ');

    case 'ZodArray':
      return `Array<${describeSchema(def.type, depth + 1, maxDepth)}>`;

    case 'ZodObject': {
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const entries = Object.entries(shape);
      if (entries.length === 0) return '{}';
      const fields = entries.map(([key, value]) => {
        const optional = isOptional(value);
        const desc = describeSchema(unwrap(value), depth + 1, maxDepth);
        const nullable = isNullable(value);
        const suffix = nullable ? ' | null' : '';
        return `${key}${optional ? '?' : ''}: ${desc}${suffix}`;
      });
      return `{ ${fields.join(', ')} }`;
    }

    case 'ZodRecord':
      return `Record<string, ${describeSchema(def.valueType, depth + 1, maxDepth)}>`;

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options as z.ZodTypeAny[];
      return options
        .map((o) => describeSchema(o, depth + 1, maxDepth))
        .join(' | ');
    }

    case 'ZodTuple': {
      const items = def.items as z.ZodTypeAny[];
      return `[${items.map((i) => describeSchema(i, depth + 1, maxDepth)).join(', ')}]`;
    }

    case 'ZodNullable':
      return `${describeSchema(def.innerType, depth, maxDepth)} | null`;

    case 'ZodOptional':
    case 'ZodDefault':
      return describeSchema(def.innerType, depth, maxDepth);

    case 'ZodEffects':
      return describeSchema(def.schema, depth, maxDepth);

    default:
      return 'unknown';
  }
}

/** Unwrap ZodOptional / ZodNullable / ZodDefault / ZodEffects to the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as any)._def;
  const typeName = def?.typeName;
  if (
    typeName === 'ZodOptional' ||
    typeName === 'ZodNullable' ||
    typeName === 'ZodDefault'
  ) {
    return unwrap(def.innerType);
  }
  if (typeName === 'ZodEffects') {
    return unwrap(def.schema);
  }
  return schema;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = (schema as any)._def;
  const typeName = def?.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
  if (typeName === 'ZodNullable') return isOptional(def.innerType);
  return false;
}

function isNullable(schema: z.ZodTypeAny): boolean {
  const def = (schema as any)._def;
  const typeName = def?.typeName;
  if (typeName === 'ZodNullable') return true;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault')
    return isNullable(def.innerType);
  return false;
}
