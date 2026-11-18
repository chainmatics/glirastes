/**
 * Declared object identity: which field of a record is its id (one field, or
 * several for a composite key), which one names it, which one stands in for a
 * missing name, of which type it is and whether its id is opaque or speaking.
 * Declared once per entity (`defineEntity`) and per tool (`outputEntities`,
 * `inputEntities`), consumed by the result overview, history compaction,
 * `read_result`, `hideIds`, the approval card and entity links. Where nothing
 * is declared, the heuristic of `entity-identity.ts` stays in charge.
 *
 * Field NAMES only, never values. Local to the app: written to the generated
 * module and `tool-contracts.json`, sent to the app's own browser, never to
 * the Platform. Dependency-free (no engine, provider or React import).
 *
 * @module
 */
// ============================================================================
// Types
// ============================================================================

/** `opaque`: an id the user never types (UUID, database integer). `speaking`: a key the user types (order number, ticket key). */
export type EntityIdKind = 'opaque' | 'speaking';

/** What an approved call does with the entity an argument names. */
export type InputEntityRole = 'target' | 'parent' | 'reference';

/** The identity of one kind of record. */
export interface EntityDeclaration {
  /** Lower-case type name (`playlist`, `channel-revision`). Without it the type is derived where the declaration is used. */
  readonly type?: string;
  /** The field that holds the record's own id, or the fields of a composite key in their order. */
  readonly id: string | ReadonlyArray<string>;
  /** The field that names the record for a person. */
  readonly name?: string;
  /** A short field that tells records apart when they have no name (`versionNumber`, `rev`). */
  readonly fallback?: string;
  /** Default: `speaking` for the fields `key`, `slug` and `code`, `opaque` otherwise. */
  readonly idKind?: EntityIdKind;
}

/** Where a tool result holds records of a declared entity. */
export interface OutputEntityDeclaration extends EntityDeclaration {
  /**
   * The objects that are records of this entity, as a result path without
   * an index: `playlists[]` (the entries), `data[].owner` (one object per
   * entry), `''` (the result itself). Paths address the result as the model
   * sees it: a list answer travels under `data`. Default: the entries of the
   * largest array of the result, or the result itself when it has none.
   */
  readonly path?: string;
}

/** An argument (or several, for a composite key) of a tool that names a record. */
export interface InputEntityRef {
  readonly type: string;
  /** Default `target`. */
  readonly role?: InputEntityRole;
  /** Argument paths in the tool input (`playlist_id`, `filter.ownerId`), in the order of the entity's composite key. */
  readonly args: string | ReadonlyArray<string>;
  /** Default: the declared entity's `idKind`, else as for {@link EntityDeclaration.idKind}. */
  readonly idKind?: EntityIdKind;
}

/** The entities one tool returns and names in its arguments. */
export interface ToolEntityDeclarations {
  readonly output?: ReadonlyArray<OutputEntityDeclaration>;
  readonly input?: ReadonlyArray<InputEntityRef>;
}

/** Declarations by the name the model calls a tool by (`playlists_list`). */
export type EntityDeclarationsByTool = Readonly<Record<string, ToolEntityDeclarations>>;

// ============================================================================
// Validation
// ============================================================================

export const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z_$][\w$-]{0,63}$/;
const PATH_STEP = /^([A-Za-z_$][\w$-]{0,63})(\[\])?$/;
/** Parts of a composite key, at most. */
export const MAX_ENTITY_ID_PARTS = 4;
/** Declarations per tool and direction, at most. */
export const MAX_TOOL_ENTITIES = 20;
const MAX_PATH_STEPS = 8;
const ID_KINDS: ReadonlySet<string> = new Set(['opaque', 'speaking']);
const ROLES: ReadonlySet<string> = new Set(['target', 'parent', 'reference']);
const SPEAKING_FIELDS: ReadonlySet<string> = new Set(['key', 'slug', 'code']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One step of a declared path: a key, entered as an object (`owner`) or through its entries (`items[]`). */
export interface EntityPathStep {
  readonly key: string;
  readonly each: boolean;
}

/** Steps of a declared output path (`''` is the result itself), or undefined when it is no such path. */
export function parseEntityPath(text: unknown): EntityPathStep[] | undefined {
  if (typeof text !== 'string') return undefined;
  if (text === '') return [];
  const parts = text.split('.');
  if (parts.length > MAX_PATH_STEPS) return undefined;
  const steps: EntityPathStep[] = [];
  for (const part of parts) {
    const match = PATH_STEP.exec(part);
    if (!match) return undefined;
    steps.push({ key: match[1]!, each: match[2] === '[]' });
  }
  return steps;
}

/** The id fields of a declaration as a list. */
export function entityIdFields(declaration: Pick<EntityDeclaration, 'id'>): string[] {
  return typeof declaration.id === 'string' ? [declaration.id] : [...declaration.id];
}

/** The argument paths of an input reference as a list. */
export function inputRefArgs(ref: Pick<InputEntityRef, 'args'>): string[] {
  return typeof ref.args === 'string' ? [ref.args] : [...ref.args];
}

/** What is wrong with a declaration, in words without its values; undefined when it is valid. */
export function entityDeclarationIssue(value: unknown, { output = false }: { output?: boolean } = {}): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  const allowed = new Set(['type', 'id', 'name', 'fallback', 'idKind', ...(output ? ['path'] : [])]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) return `has unknown keys (${extra.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 64))).join(', ')})`;
  if (value.type !== undefined && (typeof value.type !== 'string' || !ENTITY_TYPE_PATTERN.test(value.type))) {
    return 'has a type that is not a lower-case name of at most 64 characters (letters, digits, _, . and -)';
  }
  const id = value.id;
  const ids = typeof id === 'string' ? [id] : Array.isArray(id) ? id : undefined;
  if (!ids || ids.length === 0 || ids.length > MAX_ENTITY_ID_PARTS) {
    return `has no id: a field name or a list of 1 to ${MAX_ENTITY_ID_PARTS} field names`;
  }
  if (!ids.every((field) => typeof field === 'string' && FIELD_PATTERN.test(field))) return 'has an id field that is not a field name';
  if (new Set(ids).size !== ids.length) return 'names an id field twice';
  for (const key of ['name', 'fallback'] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== 'string' || !FIELD_PATTERN.test(field))) return `has a ${key} that is not a field name`;
  }
  if (value.idKind !== undefined && (typeof value.idKind !== 'string' || !ID_KINDS.has(value.idKind))) {
    return 'has an idKind that is neither opaque nor speaking';
  }
  if (output && value.path !== undefined && parseEntityPath(value.path) === undefined) {
    return 'has a path that is not a result path such as playlists[] or data[].owner (without an index)';
  }
  return undefined;
}

/** What is wrong with an input reference, in words without its values; undefined when it is valid. */
export function inputEntityRefIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  const extra = Object.keys(value).filter((key) => !['type', 'role', 'args', 'idKind'].includes(key));
  if (extra.length > 0) return `has unknown keys (${extra.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 64))).join(', ')})`;
  if (typeof value.type !== 'string' || !ENTITY_TYPE_PATTERN.test(value.type)) {
    return 'has no type: a lower-case name of at most 64 characters (letters, digits, _, . and -)';
  }
  if (value.role !== undefined && (typeof value.role !== 'string' || !ROLES.has(value.role))) {
    return 'has a role that is not target, parent or reference';
  }
  const args = typeof value.args === 'string' ? [value.args] : Array.isArray(value.args) ? value.args : undefined;
  if (!args || args.length === 0 || args.length > MAX_ENTITY_ID_PARTS) {
    return `has no args: an argument path or a list of 1 to ${MAX_ENTITY_ID_PARTS}`;
  }
  if (!args.every((arg) => typeof arg === 'string' && arg.split('.').every((part) => FIELD_PATTERN.test(part)))) {
    return 'has an argument that is not a path such as playlist_id or filter.ownerId';
  }
  if (new Set(args).size !== args.length) return 'names an argument twice';
  if (value.idKind !== undefined && (typeof value.idKind !== 'string' || !ID_KINDS.has(value.idKind))) {
    return 'has an idKind that is neither opaque nor speaking';
  }
  return undefined;
}

function frozen<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) Object.freeze(child);
  return Object.freeze(value);
}

/**
 * Declares an entity once, for every tool that returns or names it. Throws
 * on an invalid declaration, like an invalid `outputAllowedFields`.
 *
 * @example
 * ```ts
 * const Playlist = defineEntity({ type: 'playlist', id: 'playlist_id', name: 'displayName' });
 * defineEndpointTool({ ..., outputEntities: [{ ...Playlist, path: 'playlists[]' }] });
 * ```
 */
export function defineEntity<const T extends EntityDeclaration>(declaration: T): T {
  const issue = entityDeclarationIssue(declaration, { output: true });
  if (issue) throw new Error(`defineEntity: the declaration ${issue}.`);
  return frozen({ ...declaration, ...(Array.isArray(declaration.id) ? { id: [...declaration.id] } : {}) });
}

/**
 * The valid output and input declarations of a tool, or a description of the
 * first invalid one (`label` names the tool in it). For `defineTool`,
 * `endpointToolToTool` and `toolsToAiTools`: an invalid declaration throws there.
 */
export function assertToolEntities(
  value: { outputEntities?: unknown; inputEntities?: unknown },
  label: string,
): void {
  const check = (list: unknown, name: string, issueOf: (entry: unknown) => string | undefined) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || list.length > MAX_TOOL_ENTITIES) {
      throw new Error(`${label}: ${name} must be a list of at most ${MAX_TOOL_ENTITIES} declarations.`);
    }
    list.forEach((entry, index) => {
      const issue = issueOf(entry);
      if (issue) throw new Error(`${label}: ${name}[${index}] ${issue}.`);
    });
  };
  check(value.outputEntities, 'outputEntities', (entry) => entityDeclarationIssue(entry, { output: true }));
  check(value.inputEntities, 'inputEntities', inputEntityRefIssue);
}

// ============================================================================
// Reading declared records
// ============================================================================

/** The id kind of a declared field: declared, else `speaking` for `key`, `slug` and `code`, else `opaque`. */
export function entityIdKindOf(declaration: Pick<EntityDeclaration, 'id' | 'idKind'>): EntityIdKind {
  if (declaration.idKind) return declaration.idKind;
  return entityIdFields(declaration).every((field) => SPEAKING_FIELDS.has(field)) ? 'speaking' : 'opaque';
}

/** An id value: a non-empty string (at most 200 characters) or a safe integer. */
export function isEntityIdValue(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200;
}

/** The identity of one record by its declaration. */
export interface DeclaredRecordIdentity {
  readonly declaration: OutputEntityDeclaration;
  readonly idFields: string[];
  /** In the order of `idFields`. */
  readonly idValues: Array<string | number>;
  /** The name, when the declared name field holds a non-empty string. */
  readonly name?: string;
  /** The declared fallback field and its value, when it holds a short scalar. */
  readonly fallbackField?: string;
  readonly fallbackValue?: string | number;
  readonly idKind: EntityIdKind;
}

/** The identity of `record` by `declaration`; undefined when a declared id field holds no id value. */
export function declaredIdentityOf(record: unknown, declaration: OutputEntityDeclaration): DeclaredRecordIdentity | undefined {
  if (!isRecord(record)) return undefined;
  const idFields = entityIdFields(declaration);
  const idValues: Array<string | number> = [];
  for (const field of idFields) {
    const value = Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
    if (!isEntityIdValue(value)) return undefined;
    idValues.push(value);
  }
  const rawName = declaration.name ? record[declaration.name] : undefined;
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : undefined;
  const rawFallback = declaration.fallback ? record[declaration.fallback] : undefined;
  const fallbackValue = (typeof rawFallback === 'number' && Number.isFinite(rawFallback))
    || (typeof rawFallback === 'string' && rawFallback.trim() !== '' && rawFallback.length <= 80)
    ? (typeof rawFallback === 'string' ? rawFallback.trim() : rawFallback)
    : undefined;
  return {
    declaration,
    idFields,
    idValues,
    ...(name !== undefined ? { name } : {}),
    ...(fallbackValue !== undefined ? { fallbackField: declaration.fallback!, fallbackValue } : {}),
    idKind: entityIdKindOf(declaration),
  };
}

/** The display form of a composite id (`lobby/503`); a single id as it is. Not unique: never a lookup key. */
export function entityIdText(values: ReadonlyArray<string | number>): string {
  return values.map((value) => (typeof value === 'string' ? value.trim() : String(value))).join('/');
}

/**
 * The lookup form of an id: a single id as it is (so it meets the same id
 * elsewhere), a composite key as its JSON tuple (`["a/b","c"]` and
 * `["a","b/c"]` stay apart).
 */
export function entityLookupId(values: ReadonlyArray<string | number>): string | number {
  if (values.length === 1) return typeof values[0] === 'string' ? values[0].trim() : values[0]!;
  return JSON.stringify(values.map((value) => (typeof value === 'string' ? value.trim() : value)));
}

/** Keys of a result's top level that are never data (the SDK adds them). */
const PROTECTED_TOP_KEYS: ReadonlySet<string> = new Set(['success', 'uiAction', '_result', '_truncated', '_history']);

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Object keys from the root to the largest array reached through object
 * properties (not inside arrays), the overview's dominant array: by
 * serialized size, then code-unit order of the route. Undefined without one.
 */
export function largestArrayRoute(root: unknown): string[] | undefined {
  if (!isRecord(root)) return undefined;
  let best: { route: string[]; size: number; text: string } | undefined;
  const visit = (object: Record<string, unknown>, route: string[], depth: number): void => {
    if (depth > MAX_PATH_STEPS) return;
    for (const key of Object.keys(object)) {
      if (route.length === 0 && PROTECTED_TOP_KEYS.has(key)) continue;
      const value = object[key];
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const next = [...route, key];
        const size = serializedLength(value);
        const text = next.join('.');
        if (!best || size > best.size || (size === best.size && text < best.text)) best = { route: next, size, text };
      } else if (isRecord(value)) {
        visit(value, [...route, key], depth + 1);
      }
    }
  };
  visit(root, [], 0);
  return best?.route;
}

/** The steps a declaration addresses, resolving the default path against `root`. */
export function entityPathOf(declaration: OutputEntityDeclaration, root: unknown): EntityPathStep[] | undefined {
  if (declaration.path !== undefined) return parseEntityPath(declaration.path);
  if (Array.isArray(root)) return [];
  const route = largestArrayRoute(root);
  if (!route) return [];
  return route.map((key, index) => ({ key, each: index === route.length - 1 }));
}

/**
 * The objects of `root` a list of steps reaches. An `each` step goes through
 * the entries of an array and, for an indexed `read_result` answer
 * (`{ "2": { … } }`), through the values of an object with index keys. A
 * root array is entered by its entries first (a list answer the browser holds
 * without the `data` wrapper), at most `limit` objects.
 */
export function objectsAt(root: unknown, steps: ReadonlyArray<EntityPathStep>, limit = 10_000): Array<Record<string, unknown>> {
  let current: unknown[] = Array.isArray(root) ? root : [root];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const holder of current) {
      if (!isRecord(holder) || !Object.prototype.hasOwnProperty.call(holder, step.key)) continue;
      const value = holder[step.key];
      if (!step.each) next.push(value);
      else if (Array.isArray(value)) next.push(...value);
      else if (isRecord(value) && Object.keys(value).every((key) => /^\d+$/.test(key))) next.push(...Object.values(value));
      if (next.length > limit) break;
    }
    current = next;
  }
  return current.filter(isRecord).slice(0, limit);
}

/** The declared records of a tool result: each object a declaration reaches, with its identity. */
export function declaredRecordsOf(
  root: unknown,
  declarations: ReadonlyArray<OutputEntityDeclaration> | undefined,
): Map<Record<string, unknown>, DeclaredRecordIdentity> {
  const found = new Map<Record<string, unknown>, DeclaredRecordIdentity>();
  for (const declaration of declarations ?? []) {
    const steps = entityPathOf(declaration, root);
    if (!steps) continue;
    for (const record of objectsAt(root, steps)) {
      if (found.has(record)) continue;
      const identity = declaredIdentityOf(record, declaration);
      if (identity) found.set(record, identity);
    }
  }
  return found;
}

/**
 * The declaration that names the entries of the array at `route`: one whose
 * path is that route with `[]`, or one without a path when `route` is the
 * largest array of `root` (where a path-less declaration points). Undefined
 * without one.
 */
export function declarationForEntries(
  declarations: ReadonlyArray<OutputEntityDeclaration> | undefined,
  route: ReadonlyArray<string>,
  root: unknown,
): OutputEntityDeclaration | undefined {
  if (!declarations || declarations.length === 0) return undefined;
  const wanted = `${route.join('.')}[]`;
  const explicit = route.length > 0 ? declarations.find((declaration) => declaration.path === wanted) : undefined;
  if (explicit) return explicit;
  const pathless = declarations.find((declaration) => declaration.path === undefined);
  if (!pathless) return undefined;
  const largest = Array.isArray(root) ? [] : largestArrayRoute(root) ?? [];
  return largest.length === route.length && largest.every((key, index) => key === route[index]) ? pathless : undefined;
}

/** The identity fields a declaration keeps on each entry: its id fields, then the name, else the fallback. */
export function declaredIdentityKeys(declaration: EntityDeclaration): string[] {
  const keys = entityIdFields(declaration);
  if (declaration.name && !keys.includes(declaration.name)) keys.push(declaration.name);
  if (declaration.fallback && !keys.includes(declaration.fallback)) keys.push(declaration.fallback);
  return keys;
}

/** The valid entries of an `outputEntities` list (an invalid one is left out); undefined for none. */
export function validOutputEntities(value: unknown): OutputEntityDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.slice(0, MAX_TOOL_ENTITIES)
    .filter((item) => entityDeclarationIssue(item, { output: true }) === undefined) as OutputEntityDeclaration[];
  return valid.length > 0 ? valid : undefined;
}

/** The valid entries of an `inputEntities` list; undefined for none. */
export function validInputEntities(value: unknown): InputEntityRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.slice(0, MAX_TOOL_ENTITIES).filter((item) => inputEntityRefIssue(item) === undefined) as InputEntityRef[];
  return valid.length > 0 ? valid : undefined;
}

/** Tool declarations as the browser and history compaction read them: validated, or left out. */
export function sanitizeEntityDeclarations(value: unknown): Record<string, ToolEntityDeclarations> {
  const result: Record<string, ToolEntityDeclarations> = {};
  if (!isRecord(value)) return result;
  for (const [tool, entry] of Object.entries(value)) {
    if (!isRecord(entry) || tool.length > 128) continue;
    const output = validOutputEntities(entry.output) ?? [];
    const input = validInputEntities(entry.input) ?? [];
    if (output.length > 0 || input.length > 0) {
      result[tool] = { ...(output.length > 0 ? { output } : {}), ...(input.length > 0 ? { input } : {}) };
    }
  }
  return result;
}
