/**
 * Declared output fields of an endpoint tool at generation time
 * (`x-glirastes-output-allowed-fields` / `-denied-fields` / `-default-fields`
 * of an OpenAPI operation, `outputAllowedFields` / `outputDeniedFields` /
 * `outputDefaultFields` of a contract.ts entry): the effective lists, the
 * findings about them, and the contract's output schema reduced to the upper
 * bound (allowed minus denied), so the model is told about nothing it cannot
 * get. Local only: written to tool-contracts.json and the
 * generated module, never sent to the Platform.
 */
import {
  anyDepthKeys,
  intersectOutputFields,
  MAX_ANY_DEPTH,
  outputFieldCovers,
  parseAnyDepthKey,
  outputFieldsOutside,
  outputFieldTree,
  parseOutputFieldPath,
  type OutputFieldNode,
  type OutputFieldStep,
} from '../../server/core/output-fields.js';
import { compareCodeUnits } from './canonical.js';
import { toolFinding } from './findings.js';
import type { JsonSchemaLike, ObservedTool, ToolFinding } from './types.js';

/** The declarations as a source read them: valid paths (normalized), or `'invalid'`. */
export interface DeclaredOutputFields {
  /** Where they are declared, at the start of every message (`openapi.json GET /api/x`, a contract module path). */
  where: string;
  /** Names the declarations in messages: the OpenAPI extensions or the contract.ts fields. */
  form: 'openapi' | 'contract';
  allowed?: string[] | 'invalid';
  denied?: string[] | 'invalid';
  default?: string[] | 'invalid';
}

export interface ResolvedOutputFields {
  /**
   * Effective allow-list: `[]` (nothing) when the allow- or the deny-list is
   * invalid, which also disables the tool.
   */
  allowed?: string[];
  /** Effective deny-list. */
  denied?: string[];
  /** Effective default view: within `allowed`, without denied paths. */
  default?: string[];
  findings: ToolFinding[];
  /** The output schema reduced to `allowed`; undefined when it stays as it is. */
  output?: JsonSchemaLike;
}

const NAMES = {
  openapi: {
    allowed: 'x-glirastes-output-allowed-fields',
    denied: 'x-glirastes-output-denied-fields',
    default: 'x-glirastes-output-default-fields',
  },
  contract: { allowed: 'outputAllowedFields', denied: 'outputDeniedFields', default: 'outputDefaultFields' },
} as const;

/** Keys the SDK adds to every successful result; a path to them always exists. */
const RESULT_KEYS: ReadonlySet<string> = new Set(['success', 'uiAction']);
const MAX_NAMED_PATHS = 5;

/** The finding of an invalid declaration; never repeats the declared value. */
export function invalidOutputFieldsFinding(
  subject: string,
  where: string,
  form: DeclaredOutputFields['form'],
  which: 'allowed' | 'denied' | 'default',
): ToolFinding {
  const name = NAMES[form][which];
  const shape = 'a list of at most 200 field paths such as data[].name or meta (each at most 200 characters, starting with a field name, without an index)';
  // Fail closed: an upper bound that cannot be read must not expose everything.
  if (which === 'allowed') {
    return toolFinding('output-allowed-fields-invalid', 'needs_attention', subject,
      `${where} declares an ${name} that is not ${shape}; the tool stays disabled.`);
  }
  if (which === 'denied') {
    return toolFinding('output-denied-fields-invalid', 'needs_attention', subject,
      `${where} declares an ${name} that is not ${shape}; the tool stays disabled.`);
  }
  return toolFinding('output-default-fields-invalid', 'warning', subject,
    `${where} declares an ${name} that is not ${shape}; the declaration is ignored and the first answer shows every allowed field.`);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typesOf(schema: JsonObject): string[] | undefined {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === 'string');
  return undefined;
}

const COMPOSITES = ['allOf', 'anyOf', 'oneOf'] as const;
/** The schema of an array entry a denied path ending in `[]` emptied. */
const EMPTY_ENTRY: JsonObject = Object.freeze({ type: 'object', properties: {}, additionalProperties: false }) as JsonObject;
const STRUCTURE = ['type', 'properties', 'additionalProperties', 'patternProperties', 'items', 'prefixItems', '$ref', ...COMPOSITES];

function branchesOf(schema: JsonObject): JsonObject[] {
  return COMPOSITES.flatMap((keyword) => (Array.isArray(schema[keyword]) ? schema[keyword] as unknown[] : []))
    .filter(isObject);
}

/** Whether the schema says anything about the shape of a value (`{}` and annotations alone do not). */
function isStructured(schema: JsonObject): boolean {
  return STRUCTURE.some((keyword) => schema[keyword] !== undefined);
}

/**
 * The root of a result as the model sees it: an endpoint's list or scalar
 * response travels under `data`.
 */
function resultSchema(output: JsonSchemaLike): { schema: JsonObject; wrapped: boolean } {
  const types = typesOf(output);
  if (types && types.length > 0 && !types.includes('object')) {
    return { schema: { type: 'object', properties: { data: output }, additionalProperties: false }, wrapped: true };
  }
  return { schema: output, wrapped: false };
}

type PathStatus = 'exists' | 'missing' | 'unknown';

/**
 * Whether `steps` exist in `schema`: `missing` only where the schema is
 * closed enough to tell (declared properties without open
 * `additionalProperties` or `patternProperties`, or a type that cannot hold
 * the step); `unknown` for open, opaque or `$ref` parts.
 */
function pathStatus(schema: unknown, steps: ReadonlyArray<OutputFieldStep>, index = 0): PathStatus {
  if (index === steps.length) return 'exists';
  if (schema === false) return 'missing';
  if (!isObject(schema) || schema.$ref !== undefined) return 'unknown';
  const branches = branchesOf(schema);
  const own = STRUCTURE.some((keyword) => !COMPOSITES.includes(keyword as never) && schema[keyword] !== undefined)
    ? [ownStatus(schema, steps, index)]
    : [];
  const all = [...own, ...branches.map((branch) => pathStatus(branch, steps, index))];
  if (all.length === 0) return 'unknown';
  if (all.includes('exists')) return 'exists';
  return all.every((status) => status === 'missing') ? 'missing' : 'unknown';
}

function ownStatus(schema: JsonObject, steps: ReadonlyArray<OutputFieldStep>, index: number): PathStatus {
  const step = steps[index]!;
  const types = typesOf(schema);
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (step.kind === 'key') {
    if (properties && Object.prototype.hasOwnProperty.call(properties, step.key)) {
      return pathStatus(properties[step.key], steps, index + 1);
    }
    if (schema.patternProperties !== undefined) return 'unknown';
    const additional = schema.additionalProperties;
    if (additional !== undefined && additional !== false) return 'unknown';
    if (properties || additional === false) return 'missing';
    if (types && !types.includes('object')) return 'missing';
    return 'unknown';
  }
  if (schema.items !== undefined) {
    return schema.items === false ? 'missing' : pathStatus(schema.items, steps, index + 1);
  }
  if (Array.isArray(schema.prefixItems)) {
    const statuses = schema.prefixItems.map((item) => pathStatus(item, steps, index + 1));
    if (statuses.includes('exists')) return 'exists';
    return 'unknown';
  }
  if (types && !types.includes('array')) return 'missing';
  if (!types && properties) return 'missing';
  return 'unknown';
}

/** Reduces `schema` to the fields of `node`; undefined when nothing of it can be selected. */
function projectSchema(schema: unknown, node: OutputFieldNode, problems: { count: number }, closed = true): unknown {
  if (node.end || !isObject(schema) || !isStructured(schema)) return schema;
  if (schema.$ref !== undefined) {
    // Not resolved here: kept as it is (the results are reduced all the same).
    problems.count += 1;
    return schema;
  }
  const output: JsonObject = {};
  for (const keyword of ['title', 'description'] as const) {
    if (schema[keyword] !== undefined) output[keyword] = schema[keyword];
  }
  const types = typesOf(schema);
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const objectLike = properties !== undefined || schema.additionalProperties !== undefined
    || schema.patternProperties !== undefined || (types?.includes('object') ?? false);
  const arrayLike = schema.items !== undefined || schema.prefixItems !== undefined || (types?.includes('array') ?? false);
  let objectKept = false;
  let arrayKept = false;
  if (objectLike && node.keys.size > 0) {
    const kept: JsonObject = {};
    const terminal: string[] = [];
    const additional = schema.additionalProperties;
    const keys = [...node.keys.keys()].sort(compareCodeUnits);
    for (const key of keys) {
      const child = node.keys.get(key)!;
      let projected: unknown;
      if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
        projected = projectSchema(properties[key], child, problems);
      } else if (schema.patternProperties !== undefined) {
        problems.count += 1;
        projected = {};
      } else if (isObject(additional)) {
        projected = projectSchema(additional, child, problems);
      } else if (additional === undefined || additional === true) {
        if (properties) continue;
        projected = {};
      } else {
        continue;
      }
      if (projected === undefined) continue;
      kept[key] = projected;
      if (child.end) terminal.push(key);
    }
    output.properties = kept;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string' && terminal.includes(key))
      : [];
    if (required.length > 0) output.required = required;
    // The branches of an `allOf` hold together: closing each one would forbid
    // the fields of the others, so no value could satisfy the contract.
    if (closed) output.additionalProperties = false;
    objectKept = true;
  }
  if (arrayLike && node.each) {
    if (schema.items !== undefined) output.items = projectSchema(schema.items, node.each, problems) ?? {};
    if (Array.isArray(schema.prefixItems)) {
      output.prefixItems = schema.prefixItems.map((item) => projectSchema(item, node.each!, problems) ?? {});
    }
    for (const keyword of ['minItems', 'maxItems'] as const) {
      if (schema[keyword] !== undefined) output[keyword] = schema[keyword];
    }
    arrayKept = true;
  }
  if (types) {
    const kept = types.filter((type) => (type === 'object' && objectKept) || (type === 'array' && arrayKept));
    if (kept.length === 1) output.type = kept[0];
    else if (kept.length > 1) output.type = kept;
  }
  let composite = false;
  for (const keyword of COMPOSITES) {
    if (!Array.isArray(schema[keyword])) continue;
    const branches = (schema[keyword] as unknown[])
      .map((branch) => projectSchema(branch, node, problems, keyword !== 'allOf'))
      .filter((branch) => branch !== undefined);
    if (branches.length > 0) {
      output[keyword] = branches;
      composite = true;
    }
  }
  return objectKept || arrayKept || composite ? output : undefined;
}

/**
 * `schema` without the properties `node` ends in (and without them in
 * `required`), through `items`, `prefixItems`, open `additionalProperties`
 * and composites. A `$ref` or `patternProperties` on the way is kept as it
 * is and counted.
 */
function denySchema(schema: unknown, node: OutputFieldNode, problems: { count: number }): unknown {
  if (!isObject(schema) || !isStructured(schema)) return schema;
  if (schema.$ref !== undefined) {
    problems.count += 1;
    return schema;
  }
  const output: JsonObject = { ...schema };
  if (node.keys.size > 0) {
    if (isObject(schema.properties)) {
      const kept: JsonObject = {};
      for (const key of Object.keys(schema.properties)) {
        const child = node.keys.get(key);
        if (child?.end) continue;
        kept[key] = child ? denySchema(schema.properties[key], child, problems) : schema.properties[key];
      }
      output.properties = kept;
      if (Array.isArray(schema.required)) {
        const required = schema.required.filter((key) => typeof key !== 'string' || !node.keys.get(key)?.end);
        if (required.length > 0) output.required = required;
        else delete output.required;
      }
    }
    if (schema.patternProperties !== undefined) problems.count += 1;
    if (isObject(schema.additionalProperties)) {
      // A denied key may also be one of the open keys: describe that value without its denied parts.
      const open = [...node.keys].filter(([key]) => !isObject(schema.properties) || !Object.prototype.hasOwnProperty.call(schema.properties, key));
      if (open.some(([, child]) => !child.end)) problems.count += 1;
    }
  }
  if (node.each) {
    // A path ending in `[]` empties every entry: the entries stay as `{}`.
    const each = node.each;
    const entry = (item: unknown) => (each.end ? { ...EMPTY_ENTRY } : denySchema(item, each, problems));
    if (schema.items !== undefined) output.items = entry(schema.items);
    if (Array.isArray(schema.prefixItems)) output.prefixItems = schema.prefixItems.map(entry);
  }
  for (const keyword of COMPOSITES) {
    if (Array.isArray(schema[keyword])) output[keyword] = (schema[keyword] as unknown[]).map((branch) => denySchema(branch, node, problems));
  }
  // Examples and defaults of a changed object or array may show a denied value.
  for (const keyword of ['examples', 'example', 'default', 'const', 'enum']) delete output[keyword];
  return output;
}

/** Keywords whose value is one subschema, a list of subschemas, or a map of subschemas. */
const SUBSCHEMA = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'];
const SUBSCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const VALUE_KEYWORDS = ['examples', 'example', 'default', 'const', 'enum'];

/** Whether `value` (an example or default) holds a property named in `keys` anywhere. */
function holdsKey(value: unknown, keys: ReadonlySet<string>, depth = 0): boolean {
  if (typeof value !== 'object' || value === null || depth > MAX_ANY_DEPTH) return typeof value === 'object' && value !== null;
  if (Array.isArray(value)) return value.some((entry) => holdsKey(entry, keys, depth + 1));
  return Object.keys(value).some((key) => keys.has(key) || holdsKey((value as JsonObject)[key], keys, depth + 1));
}

/**
 * `schema` without every property named in `keys`, anywhere (properties,
 * items, composites, local `$defs`), and without them in `required`;
 * examples, defaults and consts that hold such a key are dropped. A copy:
 * the input (possibly shared with other tools) is never changed.
 */
function stripSchemaKeys(schema: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => stripSchemaKeys(entry, keys, depth + 1));
  if (!isObject(schema) || depth > 4 * MAX_ANY_DEPTH) return schema;
  const output: JsonObject = {};
  for (const keyword of Object.keys(schema)) {
    const value = schema[keyword];
    if (VALUE_KEYWORDS.includes(keyword) && holdsKey(value, keys)) continue;
    if (keyword === 'required' && Array.isArray(value)) {
      const required = value.filter((key) => typeof key !== 'string' || !keys.has(key));
      if (required.length > 0) output.required = required;
    } else if (SUBSCHEMA_MAPS.includes(keyword) && isObject(value)) {
      const kept: JsonObject = {};
      for (const key of Object.keys(value)) {
        if (keyword === 'properties' && keys.has(key)) continue;
        kept[key] = stripSchemaKeys(value[key], keys, depth + 1);
      }
      output[keyword] = kept;
    } else if (SUBSCHEMA.includes(keyword) || SUBSCHEMA_LISTS.includes(keyword)) {
      output[keyword] = stripSchemaKeys(value, keys, depth + 1);
    } else {
      output[keyword] = value;
    }
  }
  return output;
}

/**
 * The contract's output schema reduced to the upper bound (`allowed`, or
 * everything, minus `denied`), and how many parts could not be reduced.
 */
export function projectOutputSchema(
  output: JsonSchemaLike,
  allowed: ReadonlyArray<string> | undefined,
  denied: ReadonlyArray<string> = [],
): { schema: JsonSchemaLike; unprojected: number } {
  const problems = { count: 0 };
  const { schema: root, wrapped } = resultSchema(output);
  const allowedSchema = allowed ? projectSchema(root, outputFieldTree(allowed), problems) : root;
  const keys = anyDepthKeys(denied);
  const exactPaths = denied.filter((path) => parseOutputFieldPath(path) !== undefined);
  const exact = exactPaths.length > 0 && allowedSchema !== undefined
    ? denySchema(allowedSchema, outputFieldTree(exactPaths), problems)
    : allowedSchema;
  const projected = keys.size > 0 && exact !== undefined ? stripSchemaKeys(exact, keys) : exact;
  const schema = root;
  if (!isObject(projected)) {
    // Nothing of a structured result can be selected: the result holds no fields.
    return isStructured(schema)
      ? { schema: { type: 'object', properties: {}, additionalProperties: false }, unprojected: problems.count }
      : { schema: output, unprojected: problems.count };
  }
  if (!wrapped) return { schema: projected as JsonSchemaLike, unprojected: problems.count };
  const data = isObject(projected.properties) ? projected.properties.data : undefined;
  return {
    schema: isObject(data) ? data as JsonSchemaLike : { type: 'object', properties: {}, additionalProperties: false },
    unprojected: problems.count,
  };
}

/** Declared paths the output schema provably does not have (never for open or opaque parts). */
export function unknownOutputFields(output: JsonSchemaLike | undefined, paths: ReadonlyArray<string>): string[] {
  if (!output) return [];
  const { schema } = resultSchema(output);
  const keys = declaredKeys(schema);
  return paths.filter((path) => {
    const anyDepth = parseAnyDepthKey(path);
    // A key named nowhere in the declared parts is reported even when open parts exist.
    if (anyDepth !== undefined) return keys.size > 0 && !keys.has(anyDepth);
    const steps = parseOutputFieldPath(path);
    if (!steps) return false;
    if (steps[0]!.kind === 'key' && RESULT_KEYS.has(steps[0]!.key)) return false;
    return pathStatus(schema, steps) === 'missing';
  });
}

/** Every property name the schema declares anywhere (properties, items, composites, local `$defs`). */
function declaredKeys(schema: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 * MAX_ANY_DEPTH) return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    for (const keyword of Object.keys(node)) {
      const value = node[keyword];
      if (keyword === 'properties' && isObject(value)) {
        for (const key of Object.keys(value)) {
          keys.add(key);
          visit(value[key], depth + 1);
        }
      } else if (SUBSCHEMA_MAPS.includes(keyword) && isObject(value)) {
        for (const child of Object.values(value)) visit(child, depth + 1);
      } else if (SUBSCHEMA.includes(keyword) || SUBSCHEMA_LISTS.includes(keyword)) {
        visit(value, depth + 1);
      }
    }
  };
  visit(schema, 0);
  return keys;
}

/** A declared key that differs from the last key of `path` only by case, for the warning. */
function caseNearMiss(output: JsonSchemaLike | undefined, path: string): string | undefined {
  if (!output) return undefined;
  const steps = parseOutputFieldPath(path);
  const anyDepth = parseAnyDepthKey(path);
  const last = anyDepth ?? [...(steps ?? [])].reverse().find((step) => step.kind === 'key')?.key;
  if (last === undefined) return undefined;
  const lower = last.toLowerCase();
  return [...declaredKeys(resultSchema(output).schema)].sort(compareCodeUnits)
    .find((key) => key !== last && key.toLowerCase() === lower);
}

function named(paths: ReadonlyArray<string>): string {
  const listed = paths.slice(0, MAX_NAMED_PATHS).join(', ');
  return paths.length > MAX_NAMED_PATHS ? `${listed} and ${paths.length - MAX_NAMED_PATHS} more` : listed;
}

/**
 * The effective declarations of one tool and the findings about them
 * (invalid declarations are reported by the source that read them). `output`
 * is the contract's output schema, when the tool has a contract.
 */
export function resolveOutputFields(
  subject: string,
  declared: DeclaredOutputFields | undefined,
  output: JsonSchemaLike | undefined,
): ResolvedOutputFields {
  if (!declared || (declared.allowed === undefined && declared.denied === undefined && declared.default === undefined)) {
    return { findings: [] };
  }
  const findings: ToolFinding[] = [];
  const names = NAMES[declared.form];
  // Fail closed: with an upper bound that cannot be read nothing is allowed (the tool is disabled as well).
  const broken = declared.allowed === 'invalid' || declared.denied === 'invalid';
  const allowed = broken ? [] : declared.allowed as string[] | undefined;
  const denied = broken ? undefined : declared.denied as string[] | undefined;
  let defaults = declared.default === 'invalid' ? undefined : declared.default;
  for (const [which, paths] of [['allowed', allowed], ['denied', denied], ['default', defaults]] as const) {
    if (!paths || (broken && which === 'allowed')) continue;
    const unknown = unknownOutputFields(output, paths);
    if (unknown.length === 0) continue;
    const hints = unknown.flatMap((path) => {
      const near = caseNearMiss(output, path);
      return near ? [`${path} (the schema has ${near}; names match exactly, case included)`] : [path];
    });
    const exact = hints.filter((_hint, index) => parseAnyDepthKey(unknown[index]) === undefined);
    const anyDepth = hints.filter((_hint, index) => parseAnyDepthKey(unknown[index]) !== undefined);
    const removesNothing = which === 'denied' ? ' Such a path removes nothing: if it is misspelt, the field it means is NOT excluded.' : '';
    if (exact.length > 0) {
      findings.push(toolFinding('output-field-unknown', 'warning', subject,
        `${declared.where} declares ${names[which]} with ${exact.length === 1 ? 'a path' : `${exact.length} paths`} the response schema does not have: ${named(exact)}.${removesNothing}`));
    }
    if (anyDepth.length > 0) {
      findings.push(toolFinding('output-field-unknown', 'warning', subject,
        `${declared.where} declares ${names[which]} with ${anyDepth.length === 1 ? 'a key' : `${anyDepth.length} keys`} not found in the declared response schema: ${named(anyDepth)}; if the field only occurs in undeclared parts, ignore this.${removesNothing}`));
    }
  }
  if (defaults && allowed && !broken) {
    const outside = outputFieldsOutside(defaults, allowed);
    if (outside.length > 0) {
      findings.push(toolFinding('output-default-fields-outside-allowed', 'warning', subject,
        `${declared.where} declares ${names.default} outside ${names.allowed}: ${named(outside)}; the first answer shows only the allowed part of them.`));
    }
  }
  if (defaults && allowed) defaults = intersectOutputFields(defaults, allowed);
  if (defaults && denied) {
    const deniedTree = outputFieldTree(denied);
    const deniedKeys = anyDepthKeys(denied);
    const hidden = defaults.filter((path) => {
      const steps = parseOutputFieldPath(path)!;
      return outputFieldCovers(deniedTree, steps) || steps.some((step) => step.kind === 'key' && deniedKeys.has(step.key));
    });
    if (hidden.length > 0) {
      findings.push(toolFinding('output-default-fields-denied', 'warning', subject,
        `${declared.where} declares ${names.default} that ${names.denied} removes: ${named(hidden)}; ${hidden.length === 1 ? 'it is' : 'they are'} never shown.`));
      defaults = defaults.filter((path) => !hidden.includes(path));
    }
  }
  let projected: JsonSchemaLike | undefined;
  if ((allowed || denied) && output) {
    const reduced = projectOutputSchema(output, allowed, denied);
    projected = reduced.schema;
    if (reduced.unprojected > 0) {
      findings.push(toolFinding('output-schema-unprojected', 'warning', subject,
        `${declared.where} declares output fields, but ${reduced.unprojected === 1 ? 'one part' : `${reduced.unprojected} parts`} of the response schema (a $ref, patternProperties or an open additionalProperties) could not be reduced to them; that part of the output contract stays as it is. Results are reduced all the same.`));
    }
  }
  return {
    ...(allowed ? { allowed } : {}),
    ...(denied ? { denied } : {}),
    ...(defaults ? { default: defaults } : {}),
    findings,
    ...(projected ? { output: projected } : {}),
  };
}

/** The effective lists of a resolved contract, as `ObservedTool` carries them (absent when not declared). */
export function outputFieldLists(resolved: {
  outputAllowedFields?: string[];
  outputDeniedFields?: string[];
  outputDefaultFields?: string[];
} | undefined): Pick<ObservedTool, 'outputAllowedFields' | 'outputDeniedFields' | 'outputDefaultFields'> {
  return {
    ...(resolved?.outputAllowedFields ? { outputAllowedFields: [...resolved.outputAllowedFields] } : {}),
    ...(resolved?.outputDeniedFields ? { outputDeniedFields: [...resolved.outputDeniedFields] } : {}),
    ...(resolved?.outputDefaultFields ? { outputDefaultFields: [...resolved.outputDefaultFields] } : {}),
  };
}
