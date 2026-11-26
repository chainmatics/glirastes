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

const propMarks = new WeakMap<z.ZodType, ChatPropMark>();

/**
 * Marks a prop that accepts a literal value or a reference (`$ref`, `$item`;
 * on `Stat.value` also `$count`/`$sum`/`$said`). The JSON Schema in the
 * manifest describes the plain value type; the validator accepts references
 * on marked props by name.
 */
export function bindable<T extends z.ZodType>(schema: T): T {
  const marked = schema.clone() as T;
  propMarks.set(marked, 'bindable');
  return marked;
}

/** Marks a prop (ids, lists) that accepts only a reference (`$ref`, `$item`). */
export function refOnly(): z.ZodUnknown;
export function refOnly<T extends z.ZodType>(schema: T): T;
export function refOnly(schema?: z.ZodType): z.ZodType {
  const marked = (schema ?? z.unknown()).clone();
  propMarks.set(marked, 'refOnly');
  return marked;
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

export interface ChatComponentDefinitionInput<P extends z.ZodRawShape> {
  id: string;
  schemaVersion: number;
  description: string;
  whenToUse?: string;
  props: z.ZodObject<P>;
  children?: ChatComponentChildren;
  itemScope?: ChatComponentItemScope;
  text: ChatComponentTextRule;
}

export interface ChatComponentDefinition<P extends z.ZodRawShape = z.ZodRawShape>
  extends ChatComponentDefinitionInput<P> {
  children: ChatComponentChildren;
  /** Prop paths accepting values or references (`items[].value`, `args.*`). */
  bindable: string[];
  /** Prop paths accepting only references. */
  refOnly: string[];
}

const COMPONENT_ID = /^[A-Z][A-Za-z0-9]{0,39}$/;

type LooseDef = {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
};

function defOf(schema: z.ZodType): LooseDef {
  return (schema as unknown as { _zod: { def: LooseDef } })._zod.def;
}

function collectMarks(
  schema: z.ZodType,
  path: string,
  out: Record<ChatPropMark, string[]>,
): void {
  const mark = propMarks.get(schema);
  if (mark && path) {
    if (!out[mark].includes(path)) out[mark].push(path);
    return;
  }
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
      if (def.innerType) collectMarks(def.innerType, path, out);
      return;
    case 'object':
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        collectMarks(child, path ? `${path}.${key}` : key, out);
      }
      return;
    case 'array':
      if (def.element) collectMarks(def.element, `${path}[]`, out);
      return;
    case 'record':
      if (def.valueType) collectMarks(def.valueType, `${path}.*`, out);
      return;
    case 'union':
      for (const option of def.options ?? []) collectMarks(option, path, out);
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

export function defineChatComponent<P extends z.ZodRawShape>(
  def: ChatComponentDefinitionInput<P>,
): ChatComponentDefinition<P> {
  if (!COMPONENT_ID.test(def.id)) {
    throw new Error(`chat component id "${def.id}" must match ${COMPONENT_ID}`);
  }
  if (!Number.isInteger(def.schemaVersion) || def.schemaVersion < 1) {
    throw new Error(`chat component ${def.id}: schemaVersion must be an integer >= 1`);
  }
  const propNames = Object.keys(def.props.shape);
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
  collectMarks(def.props, '', marks);
  const defined: ChatComponentDefinition<P> = { ...def, children: def.children ?? 'none', ...marks };
  if (def.itemScope) assertCellIdField(defined);
  return defined;
}

function propsJsonSchema(def: ChatComponentDefinition): Record<string, unknown> {
  let schema: Record<string, unknown>;
  try {
    schema = z.toJSONSchema(def.props, {
      io: 'input',
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
