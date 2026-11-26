/**
 * Chat Views spec validation: checks a model-written `render_view` spec
 * against the (client-filtered) component manifest. Error strings are
 * model-facing: precise enough that the model can correct the spec once.
 * Neutral module: no React, no server imports, no JSON Schema engine (the
 * manifest uses a small JSON Schema subset validated here, fail closed on
 * anything else).
 */
import {
  CHAT_VIEW_LIMITS,
  chatViewSpecSchema,
  type ChatComponentManifest,
  type ChatComponentManifestEntry,
  type ChatViewCapabilities,
  type ChatViewSpec,
} from '../contracts/chat-view.js';
import { starterChatComponentManifest } from './starter-catalog.js';

export interface ValidateChatViewSpecOptions {
  /** `narrow` tightens the table column limit to `maxNarrowTableColumns`. */
  surface?: 'narrow' | 'workspace';
}

export type ChatViewSpecValidation =
  | { ok: true; spec: ChatViewSpec }
  | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 20;

/** Marker the catalog puts on string props that name another element. */
const ELEMENT_ID_MARKER = '#id';

const REF_KEYS = ['$ref', '$item', '$count', '$sum', '$said'] as const;
type RefKind = (typeof REF_KEYS)[number];

const REF_HINT = '{"$ref": "<toolCallId>", "path": "…"}';

/**
 * The manifest the model may use: the intersection of `manifest` and the
 * client's bound components (by `id@schemaVersion`). Never adds entries.
 */
export function effectiveChatManifest(
  manifest: ChatComponentManifest,
  capabilities?: ChatViewCapabilities,
): ChatComponentManifest {
  const listed = capabilities?.components;
  if (!listed) return { v: 1, components: [...manifest.components] };
  const keys = new Set(listed.map((c) => `${c.id}@${c.schemaVersion}`));
  return {
    v: 1,
    components: manifest.components.filter((c) => keys.has(`${c.id}@${c.schemaVersion}`)),
  };
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    const otherKeys = Object.keys(b).filter((k) => b[k] !== undefined);
    return keys.length === otherKeys.length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const starterStat = starterChatComponentManifest.components.find((c) => c.id === 'Stat');

/** `$count`/`$sum`/`$said` are allowed only on the starter `Stat.value`. */
function allowsOperators(entry: ChatComponentManifestEntry, pattern: string): boolean {
  return pattern === 'value' && starterStat !== undefined && deepEqual(entry, starterStat);
}

/** The reference kind of a value, if it is a reference object. */
export function chatRefKind(value: unknown): RefKind | undefined {
  if (!isRecord(value)) return undefined;
  return REF_KEYS.find((key) => key in value);
}

function hasExactKeys(value: Json, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isValueRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['$ref', 'path']) &&
    typeof value.$ref === 'string' &&
    value.$ref.length > 0 &&
    typeof value.path === 'string' &&
    value.path.length > 0
  );
}

/** Shape error of a reference object, or undefined when it is well formed. */
function refShapeError(kind: RefKind, value: Json): string | undefined {
  switch (kind) {
    case '$ref':
      return isValueRef(value) ? undefined : `invalid reference; expected ${REF_HINT}`;
    case '$item':
      return hasExactKeys(value, ['$item']) &&
        typeof value.$item === 'string' &&
        value.$item.length > 0
        ? undefined
        : 'invalid reference; expected {"$item": "<field>"}';
    case '$count':
    case '$sum':
      return hasExactKeys(value, [kind]) && isValueRef(value[kind])
        ? undefined
        : `invalid operator; expected {"${kind}": ${REF_HINT}}`;
    case '$said': {
      const ok =
        hasExactKeys(value, ['$said', 'basis']) &&
        typeof value.$said === 'string' &&
        value.$said.length > 0 &&
        isValueRef(value.basis);
      if (!ok) return `invalid statement; expected {"$said": "<text>", "basis": ${REF_HINT}}`;
      if ((value.$said as string).length > CHAT_VIEW_LIMITS.maxLiteralChars) {
        return `"$said" has ${(value.$said as string).length} characters; the maximum is ${CHAT_VIEW_LIMITS.maxLiteralChars}`;
      }
      return undefined;
    }
  }
}

/** A string prop pointing at another element (from a `#id` schema). */
interface ElementIdProp {
  display: string;
  id: string;
  /** Prop path pattern, e.g. `columns[].cell`. */
  pattern: string;
}

interface PropsContext {
  entry: ChatComponentManifestEntry;
  inItemScope: boolean;
  errors: string[];
  idProps: ElementIdProp[];
}

const ANNOTATIONS = new Set([
  'description',
  'title',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
  '$schema',
  '$id',
  'contentEncoding',
  'contentMediaType',
]);

const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'anyOf',
  'oneOf',
  'allOf',
]);

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  const actual = jsonType(value);
  return types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function matchesFormat(value: string, format: string): boolean | undefined {
  if (format === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  }
  if (format === 'date-time') {
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value))
    );
  }
  return undefined;
}

function describeForm(schema: unknown): string {
  if (!isRecord(schema)) return 'value';
  if (typeof schema.format === 'string') return schema.format;
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (typeof schema.type === 'string') return schema.type;
  return 'value';
}

const at = (display: string, message: string) => (display ? `${display}: ${message}` : message);

/**
 * Validates `value` against a JSON Schema subset, collecting model-facing
 * errors. `pattern` is the mark path (`items[].value`, `args.*`) used to
 * decide where references are allowed.
 */
function checkValue(
  value: unknown,
  schema: unknown,
  display: string,
  pattern: string,
  ctx: PropsContext,
): void {
  const { entry, errors } = ctx;
  const kind = chatRefKind(value);
  if (kind) {
    checkRef(kind, value as Json, display, pattern, ctx);
    return;
  }
  if (pattern && entry.refOnly.includes(pattern)) {
    errors.push(at(display, `only accepts a reference ${REF_HINT}`));
    return;
  }
  if (typeof value === 'string' && value.length > CHAT_VIEW_LIMITS.maxLiteralChars) {
    errors.push(
      at(display, `string has ${value.length} characters; the maximum is ${CHAT_VIEW_LIMITS.maxLiteralChars}`),
    );
    return;
  }
  if (schema === true || schema === undefined) schema = {};
  if (schema === false) {
    errors.push(at(display, 'is not allowed'));
    return;
  }
  if (!isRecord(schema)) {
    errors.push(at(display, `component ${entry.id} has an invalid prop schema`));
    return;
  }
  const unsupported = Object.keys(schema).find((k) => !SUPPORTED.has(k) && !ANNOTATIONS.has(k));
  if (unsupported) {
    errors.push(
      at(display, `component ${entry.id} uses the unsupported schema keyword "${unsupported}"; it cannot be validated`),
    );
    return;
  }

  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = schema[combinator];
    if (!Array.isArray(branches)) continue;
    const results = branches.map((branch) => {
      const sub: PropsContext = { ...ctx, errors: [], idProps: [] };
      checkValue(value, branch, display, pattern, sub);
      return sub;
    });
    const passing = results.filter((r) => r.errors.length === 0);
    if (combinator === 'anyOf' ? passing.length === 0 : passing.length !== 1) {
      const typed = branches.filter(
        (b) => isRecord(b) && (b.type === undefined || matchesType(value, b.type)),
      );
      if (typed.length === 1 && passing.length === 0) {
        errors.push(...results[branches.indexOf(typed[0])]!.errors);
      } else {
        errors.push(at(display, `expected ${branches.map(describeForm).join(' or ')}`));
      }
      return;
    }
    if (passing[0]) ctx.idProps.push(...passing[0].idProps);
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) checkValue(value, part, display, pattern, ctx);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(at(display, `expected ${describeForm({ type: schema.type })}`));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(at(display, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`));
    return;
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(at(display, `must be ${JSON.stringify(schema.const)}`));
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(at(display, `must have at least ${schema.minLength} characters`));
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(at(display, `must have at most ${schema.maxLength} characters`));
    }
    if (typeof schema.pattern === 'string') {
      let regex: RegExp | undefined;
      try {
        regex = new RegExp(schema.pattern, 'u');
      } catch {
        errors.push(at(display, `component ${entry.id} has an invalid pattern; it cannot be validated`));
      }
      if (regex && !regex.test(value)) errors.push(at(display, `must match ${schema.pattern}`));
    } else if (typeof schema.format === 'string' && typeof schema.pattern !== 'string') {
      const ok = matchesFormat(value, schema.format);
      if (ok === undefined) {
        errors.push(at(display, `component ${entry.id} uses the unsupported format "${schema.format}"`));
      } else if (!ok) {
        errors.push(at(display, `must be a ${schema.format}`));
      }
    }
    if (schema.description === ELEMENT_ID_MARKER) {
      ctx.idProps.push({ display, id: value, pattern });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(at(display, `must be >= ${schema.minimum}`));
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(at(display, `must be <= ${schema.maximum}`));
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(at(display, `must be > ${schema.exclusiveMinimum}`));
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(at(display, `must be < ${schema.exclusiveMaximum}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(at(display, `needs at least ${schema.minItems} items`));
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(at(display, `allows at most ${schema.maxItems} items`));
    }
    value.forEach((item, i) =>
      checkValue(item, schema.items, `${display}[${i}]`, `${pattern}[]`, ctx),
    );
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const name of required) {
      if (value[name] === undefined) {
        errors.push(at(display, `missing required prop "${name}"`));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const childDisplay = display ? `${display}.${key}` : key;
      if (key in properties) {
        checkValue(child, properties[key], childDisplay, pattern ? `${pattern}.${key}` : key, ctx);
        continue;
      }
      if (schema.additionalProperties === false) {
        const allowed = Object.keys(properties);
        errors.push(
          at(display, `unknown prop "${key}" (allowed: ${allowed.length ? allowed.join(', ') : 'none'})`),
        );
        continue;
      }
      if (schema.propertyNames !== undefined) {
        const sub: PropsContext = { ...ctx, errors: [], idProps: [] };
        checkValue(key, schema.propertyNames, '', '', sub);
        if (sub.errors.length) errors.push(at(display, `invalid key "${key}"`));
      }
      checkValue(
        child,
        schema.additionalProperties,
        childDisplay,
        pattern ? `${pattern}.*` : '*',
        ctx,
      );
    }
  }
}

function checkRef(
  kind: RefKind,
  value: Json,
  display: string,
  pattern: string,
  ctx: PropsContext,
): void {
  const { entry, errors } = ctx;
  if (kind === '$count' || kind === '$sum' || kind === '$said') {
    if (!allowsOperators(entry, pattern)) {
      errors.push(
        at(
          display,
          kind === '$said'
            ? '"$said" is only allowed in Stat.value; use {"$count": …} or {"$sum": …}'
            : `"${kind}" is only allowed in Stat.value`,
        ),
      );
      return;
    }
  } else if (!entry.bindable.includes(pattern) && !entry.refOnly.includes(pattern)) {
    const marked = [...entry.bindable, ...entry.refOnly];
    errors.push(
      at(
        display,
        `references are only allowed on bindable props (${
          marked.length ? `${entry.id}: ${marked.join(', ')}` : `${entry.id} has none`
        })`,
      ),
    );
    return;
  }
  if (kind === '$item' && !ctx.inItemScope) {
    errors.push(
      at(display, `"$item" is only allowed in the cell element of a Table column; use ${REF_HINT}`),
    );
    return;
  }
  const shapeError = refShapeError(kind, value);
  if (shapeError) errors.push(at(display, shapeError));
}

/** Names of the `#id` fields of the items of an item-scope cells prop. */
function cellIdFields(entry: ChatComponentManifestEntry): string[] {
  const scope = entry.itemScope;
  const props = isRecord(entry.props.properties) ? entry.props.properties : {};
  const cells = scope ? props[scope.cellsProp] : undefined;
  const items = isRecord(cells) && isRecord(cells.items) ? cells.items : undefined;
  const fields = items && isRecord(items.properties) ? items.properties : {};
  return Object.entries(fields)
    .filter(([, schema]) => isRecord(schema) && schema.description === ELEMENT_ID_MARKER)
    .map(([name]) => name);
}

/**
 * The manifest entry a spec element type resolves to: the highest
 * `schemaVersion` of that id in the (effective) manifest.
 */
export function resolveChatComponentEntry(
  manifest: ChatComponentManifest,
  type: string,
): ChatComponentManifestEntry | undefined {
  let found: ChatComponentManifestEntry | undefined;
  for (const entry of manifest.components) {
    if (entry.id === type && (!found || entry.schemaVersion > found.schemaVersion)) found = entry;
  }
  return found;
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map((issue) => {
    const path = ['spec', ...issue.path.map(String)].join('.');
    return `${path}: ${issue.message}`;
  });
}

function capped(errors: string[]): string[] {
  if (errors.length <= MAX_REPORTED_ERRORS) return errors;
  return [
    ...errors.slice(0, MAX_REPORTED_ERRORS),
    `… and ${errors.length - MAX_REPORTED_ERRORS} more errors`,
  ];
}

/**
 * Validates a `render_view` spec: structure, limits, element graph (root,
 * children, cycles, depth), component props against the manifest's JSON
 * Schema, and where references, operators and `$said` may appear.
 */
export function validateChatViewSpec(
  spec: unknown,
  manifest: ChatComponentManifest,
  options: ValidateChatViewSpecOptions = {},
): ChatViewSpecValidation {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(spec);
  } catch {
    return { ok: false, errors: ['the spec is not valid JSON'] };
  }
  const bytes = new TextEncoder().encode(serialized ?? '').length;
  if (bytes > CHAT_VIEW_LIMITS.maxSpecBytes) {
    return {
      ok: false,
      errors: [`the spec has ${bytes} bytes; the maximum is ${CHAT_VIEW_LIMITS.maxSpecBytes}`],
    };
  }
  const parsed = chatViewSpecSchema.safeParse(spec);
  if (!parsed.success) return { ok: false, errors: capped(zodIssues(parsed.error)) };
  const view = parsed.data;
  const errors: string[] = [];
  const ids = Object.keys(view.elements);

  if (ids.length > CHAT_VIEW_LIMITS.maxElements) {
    errors.push(`the view has ${ids.length} elements; the maximum is ${CHAT_VIEW_LIMITS.maxElements}`);
  }
  if (!view.elements[view.root]) errors.push(`root "${view.root}" is not an element`);

  const known = [...new Set(manifest.components.map((c) => c.id))];
  const entries = new Map<string, ChatComponentManifestEntry>();
  for (const id of ids) {
    const element = view.elements[id]!;
    const entry = resolveChatComponentEntry(manifest, element.type);
    if (entry) entries.set(id, entry);
    else {
      errors.push(
        `element "${id}": unknown component "${element.type}" (known: ${known.join(', ') || 'none'})`,
      );
    }
  }

  // Cell elements of item-scope components (Table columns) may use `$item`.
  const cellIds = new Set<string>();
  for (const [id, entry] of entries) {
    if (!entry.itemScope) continue;
    const cells = view.elements[id]!.props[entry.itemScope.cellsProp];
    if (!Array.isArray(cells)) continue;
    const fields = cellIdFields(entry);
    for (const cell of cells) {
      if (!isRecord(cell)) continue;
      for (const field of fields) {
        if (typeof cell[field] === 'string') cellIds.add(cell[field] as string);
      }
    }
  }

  const edges = new Map<string, string[]>();
  for (const id of ids) {
    const element = view.elements[id]!;
    const entry = entries.get(id);
    const label = `element "${id}"${entry ? ` (${entry.id})` : ''}`;
    const targets: string[] = [];
    const children = element.children ?? [];
    for (const child of children) {
      targets.push(child);
      const childElement = view.elements[child];
      if (!childElement) {
        errors.push(`${label}: child "${child}" is not an element`);
      } else if (entry && Array.isArray(entry.children) && !entry.children.includes(childElement.type)) {
        errors.push(
          `${label}: child "${child}" is a ${childElement.type}; allowed: ${entry.children.join(', ')}`,
        );
      }
    }
    if (entry && entry.children === 'none' && children.length > 0) {
      errors.push(`${label}: ${entry.id} takes no children`);
    }
    if (!entry) {
      edges.set(id, targets);
      continue;
    }

    const ctx: PropsContext = { entry, inItemScope: cellIds.has(id), errors: [], idProps: [] };
    checkValue(element.props, entry.props, '', '', ctx);
    errors.push(...ctx.errors.map((message) => `${label}: ${message}`));
    for (const ref of ctx.idProps) {
      targets.push(ref.id);
      if (!view.elements[ref.id]) errors.push(`${label}: ${ref.display} "${ref.id}" is not an element`);
    }

    if (entry.itemScope) {
      const columns = element.props[entry.itemScope.cellsProp];
      const narrow = options.surface === 'narrow';
      const limit = narrow ? CHAT_VIEW_LIMITS.maxNarrowTableColumns : CHAT_VIEW_LIMITS.maxTableColumns;
      if (Array.isArray(columns) && columns.length > limit) {
        errors.push(
          `${label}: ${columns.length} ${entry.itemScope.cellsProp} exceed the limit of ${limit}${narrow ? ' on a narrow surface' : ''}`,
        );
      }
    }

    const properties = isRecord(entry.props.properties) ? entry.props.properties : {};
    if (entry.id === 'Action' && 'prompt' in properties && 'uiAction' in properties) {
      const targetCount = ['prompt', 'uiAction'].filter((p) => element.props[p] !== undefined).length;
      if (targetCount !== 1) {
        errors.push(`${label}: needs exactly one target, "prompt" or "uiAction"`);
      }
    }
    edges.set(id, targets);
  }

  // Element graph: one place per element, no cycles, bounded depth, all reachable.
  const parents = new Map<string, number>();
  for (const targets of edges.values()) {
    for (const target of targets) {
      if (view.elements[target]) parents.set(target, (parents.get(target) ?? 0) + 1);
    }
  }
  for (const [id, count] of parents) {
    if (count > 1) errors.push(`element "${id}" is used more than once; every element has one place`);
  }
  if (view.elements[view.root]) {
    const visited = new Set<string>();
    const onPath = new Set<string>();
    const visit = (id: string, depth: number): void => {
      // Report only the first element past the limit on each path.
      if (depth === CHAT_VIEW_LIMITS.maxDepth + 1) {
        errors.push(`element "${id}" is at depth ${depth}; the maximum depth is ${CHAT_VIEW_LIMITS.maxDepth}`);
      }
      visited.add(id);
      onPath.add(id);
      for (const target of edges.get(id) ?? []) {
        if (!view.elements[target]) continue;
        if (onPath.has(target)) {
          const type = view.elements[id]!.type;
          errors.push(`cycle: element "${id}" (${type}) contains "${target}", which contains it`);
          continue;
        }
        if (!visited.has(target)) visit(target, depth + 1);
      }
      onPath.delete(id);
    };
    visit(view.root, 1);
    for (const id of ids) {
      if (!visited.has(id)) {
        errors.push(`element "${id}" is not reachable from the root "${view.root}"`);
      }
    }
  }

  return errors.length ? { ok: false, errors: capped(errors) } : { ok: true, spec: view };
}
