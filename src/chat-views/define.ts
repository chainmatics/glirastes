/**
 * Chat Views catalog authoring: define components with Zod props and turn
 * them into the JSON component manifest (the runtime source of truth).
 * Neutral module: no React, no server imports.
 */
import { z } from 'zod';
import type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
} from '../contracts/chat-view.js';
import { cellIdFields } from './element-id.js';

type ChatPropMark = 'bindable' | 'refOnly';

/**
 * The structural minimum of a zod 4 schema: zod 4 itself or the `zod/v4`
 * build shipped in zod 3.25 and later. Typed structurally so an app's zod
 * types are never compared with the SDK's own (two zod type trees exhaust
 * `tsc`'s memory); the props type is read from `_zod.output`, as `z.infer` does.
 */
export interface ChatPropSchema {
  readonly _zod: { readonly def: unknown; readonly output: unknown };
}

/** The props type a component receives for its props schema (`z.infer` of it). */
export type ChatPropsOf<S extends ChatPropSchema> = S['_zod']['output'];

/** `code` of the error for a schema that is not zod 4; the tools probe reports it (probe-child.mjs). */
const CHAT_SCHEMA_UNSUPPORTED = 'GLIRASTES_CHAT_SCHEMA_UNSUPPORTED';

const ZOD_V4_HINT = "Import z from 'zod/v4' (shipped with zod 3.25 and later: import { z } from 'zod/v4') or use zod 4.";

type LooseDef = {
  type: string;
  innerType?: unknown;
  shape?: Record<string, unknown>;
  element?: unknown;
  valueType?: unknown;
  options?: unknown[];
};

function unsupportedSchema(where: string, value: unknown): Error {
  const zod3 = value !== null && typeof value === 'object' && '_def' in value && !('_zod' in value);
  const error = new Error(zod3
    ? `${where}: this is a zod 3 schema (the classic 'zod' API of zod 3.x); chat views need zod 4 schemas. ${ZOD_V4_HINT}`
    : `${where}: expected a zod 4 schema. ${ZOD_V4_HINT}`);
  (error as Error & { code: string }).code = CHAT_SCHEMA_UNSUPPORTED;
  return error;
}

/** The zod 4 definition of `schema`; a clear error for zod 3 and anything else. */
function defOf(schema: unknown, where: string): LooseDef {
  const internals = schema !== null && typeof schema === 'object'
    ? (schema as { _zod?: { def?: unknown } })._zod
    : undefined;
  const def = internals?.def;
  if (def === null || typeof def !== 'object' || typeof (def as LooseDef).type !== 'string') {
    throw unsupportedSchema(where, schema);
  }
  return def as LooseDef;
}

const propMarks = new WeakMap<object, ChatPropMark>();

/**
 * A copy of `schema` carrying `mark`, so a schema the caller reuses elsewhere
 * stays unmarked. Copied by the schema's own zod (`clone`), which may be
 * another zod 4 build than the SDK's.
 */
function marked<T extends ChatPropSchema>(schema: T, mark: ChatPropMark, where: string): T {
  defOf(schema, where);
  const clone = (schema as { clone?: unknown }).clone;
  if (typeof clone !== 'function') throw unsupportedSchema(where, schema);
  const copy = clone.call(schema) as T;
  propMarks.set(copy, mark);
  return copy;
}

/**
 * Marks a prop that accepts a literal value or a reference (`$ref`, `$item`;
 * on `Stat.value` also `$count`/`$sum`/`$said`). The JSON Schema in the
 * manifest describes the plain value type; the validator accepts references
 * on marked props by name.
 */
export function bindable<T extends ChatPropSchema>(schema: T): T {
  return marked(schema, 'bindable', 'bindable()');
}

/** Marks a prop (ids, lists) that accepts only a reference (`$ref`, `$item`). */
export function refOnly(): z.ZodUnknown;
export function refOnly<T extends ChatPropSchema>(schema: T): T;
export function refOnly(schema?: ChatPropSchema): ChatPropSchema {
  return marked(schema ?? z.unknown(), 'refOnly', 'refOnly()');
}

export type ChatComponentChildren = 'none' | 'any' | string[];

export interface ChatComponentItemScope {
  /** Prop holding the row list reference. */
  rowsProp: string;
  /** Prop whose entries name the per-row cell elements. */
  cellsProp: string;
}

export interface ChatComponentTextRule {
  label?: string;
  value?: string;
  rows?: string;
  columns?: string;
}

export interface ChatComponentDefinitionInput<S extends ChatPropSchema = ChatPropSchema> {
  id: string;
  schemaVersion: number;
  description: string;
  whenToUse?: string;
  /** A zod 4 `z.object(...)`: zod 4, or `zod/v4` of zod 3.25 and later. */
  props: S;
  children?: ChatComponentChildren;
  itemScope?: ChatComponentItemScope;
  text: ChatComponentTextRule;
}

export interface ChatComponentDefinition<S extends ChatPropSchema = ChatPropSchema>
  extends ChatComponentDefinitionInput<S> {
  children: ChatComponentChildren;
  /** Prop paths accepting values or references (`items[].value`, `args.*`). */
  bindable: string[];
  /** Prop paths accepting only references. */
  refOnly: string[];
}

const COMPONENT_ID = /^[A-Z][A-Za-z0-9]{0,39}$/;

function collectMarks(
  schema: unknown,
  path: string,
  out: Record<ChatPropMark, string[]>,
  where: string,
): void {
  const mark = propMarks.get(schema as object);
  if (mark && path) {
    if (!out[mark].includes(path)) out[mark].push(path);
    return;
  }
  const def = defOf(schema, where);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
      if (def.innerType) collectMarks(def.innerType, path, out, where);
      return;
    case 'object':
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        collectMarks(child, path ? `${path}.${key}` : key, out, where);
      }
      return;
    case 'array':
      if (def.element) collectMarks(def.element, `${path}[]`, out, where);
      return;
    case 'record':
      if (def.valueType) collectMarks(def.valueType, `${path}.*`, out, where);
      return;
    case 'union':
      for (const option of def.options ?? []) collectMarks(option, path, out, where);
      return;
    default:
      return;
  }
}

/**
 * An item-scope component names its cell elements in a `chatElementId()`
 * field of its cells prop's entries; without one no cell can be placed.
 * Props that cannot become JSON Schema are left to `toChatComponentManifest`.
 */
function assertCellIdField(def: ChatComponentDefinition): void {
  let props: Record<string, unknown>;
  try {
    props = propsJsonSchema(def);
  } catch {
    return;
  }
  if (cellIdFields({ props, itemScope: def.itemScope }).length === 0) {
    throw new Error(
      `chat component ${def.id}: itemScope.cellsProp "${def.itemScope!.cellsProp}" must be a list of objects `
        + 'with a chatElementId() field naming the cell element',
    );
  }
}

export function defineChatComponent<S extends ChatPropSchema>(
  def: ChatComponentDefinitionInput<S>,
): ChatComponentDefinition<S> {
  if (!COMPONENT_ID.test(def.id)) {
    throw new Error(`chat component id "${def.id}" must match ${COMPONENT_ID}`);
  }
  if (!Number.isInteger(def.schemaVersion) || def.schemaVersion < 1) {
    throw new Error(`chat component ${def.id}: schemaVersion must be an integer >= 1`);
  }
  const where = `chat component ${def.id}`;
  const propsDef = defOf(def.props, where);
  if (propsDef.type !== 'object') throw new Error(`${where}: props must be a z.object(...)`);
  const propNames = Object.keys(propsDef.shape ?? {});
  const named = [
    ...Object.values(def.text),
    ...(def.itemScope ? [def.itemScope.rowsProp, def.itemScope.cellsProp] : []),
  ].filter((name): name is string => typeof name === 'string');
  for (const name of named) {
    if (!propNames.includes(name)) {
      throw new Error(`chat component ${def.id}: unknown prop "${name}" in text or itemScope`);
    }
  }
  const marks: Record<ChatPropMark, string[]> = { bindable: [], refOnly: [] };
  collectMarks(def.props, '', marks, where);
  const defined: ChatComponentDefinition<S> = { ...def, children: def.children ?? 'none', ...marks };
  if (def.itemScope) assertCellIdField(defined);
  return defined;
}

/**
 * Metadata (`.describe()`, `.meta()`) from the SDK's zod registry and, for a
 * schema of another zod 4 build (`zod/v4` of zod 3.25), from that build's own
 * registry through the schema's `meta()`.
 */
const anyZodMetadata = {
  get(schema: unknown): Record<string, unknown> | undefined {
    const own = z.globalRegistry.get(schema as z.ZodType);
    if (own) return own as Record<string, unknown>;
    const meta = (schema as { meta?: unknown }).meta;
    if (typeof meta !== 'function') return undefined;
    const found: unknown = meta.call(schema);
    return found !== null && typeof found === 'object' ? found as Record<string, unknown> : undefined;
  },
} as unknown as typeof z.globalRegistry;

function propsJsonSchema(def: ChatComponentDefinition): Record<string, unknown> {
  defOf(def.props, `chat component ${def.id}@${def.schemaVersion}`);
  let schema: Record<string, unknown>;
  try {
    schema = z.toJSONSchema(def.props as unknown as z.ZodType, {
      io: 'input',
      metadata: anyZodMetadata,
      unrepresentable: 'throw',
      override: (ctx) => {
        const zodDef = (ctx.zodSchema as unknown as {
          _zod: { def: { type: string; checks?: Array<{ _zod: { def: { check: string } } }> } };
        })._zod.def;
        // `io: 'input'` would silently describe only the input side of a transform.
        if (zodDef.type === 'pipe' || zodDef.type === 'transform') {
          throw new Error('transforms cannot be represented in JSON Schema');
        }
        if (zodDef.checks?.some((check) => check._zod.def.check === 'custom')) {
          throw new Error('refinements cannot be represented in JSON Schema');
        }
        // Unknown props are a spec error, also where `io: 'input'` leaves objects open.
        if (zodDef.type === 'object' && ctx.jsonSchema.additionalProperties === undefined) {
          ctx.jsonSchema.additionalProperties = false;
        }
      },
    }) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `chat component ${def.id}@${def.schemaVersion}: props must be a plain JSON Schema subset (${reason})`,
    );
  }
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

export function toChatComponentManifest(defs: ChatComponentDefinition[]): ChatComponentManifest {
  const seen = new Set<string>();
  const components = defs.map((def): ChatComponentManifestEntry => {
    const key = `${def.id}@${def.schemaVersion}`;
    if (seen.has(key)) throw new Error(`duplicate chat component ${key}`);
    seen.add(key);
    return {
      id: def.id,
      schemaVersion: def.schemaVersion,
      description: def.description,
      ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
      props: propsJsonSchema(def),
      bindable: [...def.bindable],
      refOnly: [...def.refOnly],
      children: Array.isArray(def.children) ? [...def.children] : def.children,
      ...(def.itemScope ? { itemScope: { ...def.itemScope } } : {}),
      text: { ...def.text },
    };
  });
  return { v: 1, components };
}

/** Entries of `b` replace those of `a` with the same id@schemaVersion. */
export function mergeChatManifests(
  a: ChatComponentManifest,
  b: ChatComponentManifest,
): ChatComponentManifest {
  const keyOf = (entry: ChatComponentManifestEntry) => `${entry.id}@${entry.schemaVersion}`;
  const replacements = new Map(b.components.map((entry) => [keyOf(entry), entry]));
  const components = a.components.map((entry) => {
    const replacement = replacements.get(keyOf(entry));
    if (replacement) replacements.delete(keyOf(entry));
    return replacement ?? entry;
  });
  return { v: 1, components: [...components, ...replacements.values()] };
}
