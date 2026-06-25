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
 * }), 5)
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

/** Read Zod v4's internal schema definition (`schema._zod.def`). */
function getDef(schema: z.ZodTypeAny): any {
  return (schema as any)?._zod?.def;
}

function describeSchema(
  schema: z.ZodTypeAny,
  depth: number,
  maxDepth: number,
): string {
  if (depth >= maxDepth) return '...';

  const def = getDef(schema);
  const type = def?.type as string | undefined;

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'string'; // Dates serialize as strings in JSON
    case 'literal':
      // Zod v4 literals hold an array of allowed values.
      return (def.values as unknown[])
        .map((v) => JSON.stringify(v))
        .join(' | ');
    case 'null':
      return 'null';
    case 'undefined':
    case 'void':
      return type;
    case 'any':
      return 'any';
    case 'unknown':
      return 'unknown';

    case 'enum': {
      // Zod v4 stores enum members in an `entries` record (covers both string
      // enums and native enums). Emit the string values only.
      const values = Object.values(
        def.entries as Record<string, string | number>,
      ).filter((v): v is string => typeof v === 'string');
      return values.map((v) => `"${v}"`).join(' | ');
    }

    case 'array':
      return `Array<${describeSchema(def.element, depth + 1, maxDepth)}>`;

    case 'object': {
      const shape = def.shape as Record<string, z.ZodTypeAny>;
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

    case 'record':
      return `Record<string, ${describeSchema(def.valueType, depth + 1, maxDepth)}>`;

    case 'union': {
      // Covers both unions and discriminated unions in Zod v4.
      const options = def.options as z.ZodTypeAny[];
      return options
        .map((o) => describeSchema(o, depth + 1, maxDepth))
        .join(' | ');
    }

    case 'tuple': {
      const items = def.items as z.ZodTypeAny[];
      return `[${items.map((i) => describeSchema(i, depth + 1, maxDepth)).join(', ')}]`;
    }

    case 'nullable':
      return `${describeSchema(def.innerType, depth, maxDepth)} | null`;

    case 'optional':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return describeSchema(def.innerType, depth, maxDepth);

    case 'pipe':
      // Transforms / refinements become pipes in Zod v4; describe the input
      // side, matching the pre-v4 behaviour of describing the base schema.
      return describeSchema(def.in, depth, maxDepth);

    case 'lazy':
      return describeSchema(def.getter(), depth, maxDepth);

    default:
      return 'unknown';
  }
}

/** Unwrap optional / nullable / default / pipe wrappers to the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = getDef(schema);
  const type = def?.type;
  if (
    type === 'optional' ||
    type === 'nullable' ||
    type === 'default' ||
    type === 'prefault' ||
    type === 'catch' ||
    type === 'readonly' ||
    type === 'nonoptional'
  ) {
    return unwrap(def.innerType);
  }
  if (type === 'pipe') {
    return unwrap(def.in);
  }
  return schema;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = getDef(schema);
  const type = def?.type;
  if (type === 'optional' || type === 'default' || type === 'prefault') {
    return true;
  }
  if (type === 'nullable' || type === 'readonly' || type === 'catch') {
    return isOptional(def.innerType);
  }
  return false;
}

function isNullable(schema: z.ZodTypeAny): boolean {
  const def = getDef(schema);
  const type = def?.type;
  if (type === 'nullable') return true;
  if (
    type === 'optional' ||
    type === 'default' ||
    type === 'prefault' ||
    type === 'readonly' ||
    type === 'catch'
  ) {
    return isNullable(def.innerType);
  }
  return false;
}
