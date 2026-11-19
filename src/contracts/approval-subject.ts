/**
 * Server-side approval subjects: before the approval card of a write call is
 * shown, the server looks the records the call names up through a declared
 * read source, with the user's own credentials, and sends the browser what
 * it found (`data-approval-subjects`). The card names the record from the
 * backend instead of guessing it from the chat history; a call for a record
 * that does not exist (or that this user cannot see) gets no card at all.
 *
 * Declarations (field names, types, tool names; never values):
 * - on a read tool, `entityLookup`: which entity type it can look up and how
 *   its parameters are filled (`EntityLookup`);
 * - on a write tool, the existing `inputEntities` name the arguments that
 *   hold an id; `approvalSubject` adjusts which of them are looked up, adds a
 *   bounded preview and the failure behaviour (`ApprovalSubjectDeclaration`);
 * - on a non-GET source, `lookupEffect: 'read'` states that a lookup or a
 *   preview call through it changes nothing. It is only read for lookups and
 *   previews; it never lowers the risk class or the approval of the tool
 *   when the model calls it.
 *
 * Local to the app: generated module, `tool-contracts.json`, the runtime
 * container artifact and the app's own browser. Nothing here goes to the
 * Platform. Dependency-free (no engine, provider or React import), so the
 * React bundle can import it.
 *
 * @module
 */
import { ENTITY_TYPE_PATTERN } from './entity-declaration.js';
import { isLanguageTag, MAX_TEXT_LANGUAGES, type LocalizedText } from './localized-text.js';

// ============================================================================
// Declarations
// ============================================================================

/** Whether a source answers with one record or a list. */
export type EntityLookupResult = 'one' | 'list';

/**
 * A lookup parameter: the id field of the looked-up entity it carries
 * (`'playlist_id'`, a part of a composite key), or `{ ref: '<type>' }` for the
 * id of the call's reference of another type (the parent playlist of a
 * version, say).
 */
export type EntityLookupParam = string | { readonly ref: string };

/** A fixed parameter value of a lookup (`{ limit: 50 }`). */
export type EntityLookupConst = string | number | boolean;

/**
 * How a read tool looks up records of one entity type. The read tool must
 * declare the entity in its `outputEntities` (id, name, fallback): that is how
 * the answer is read.
 */
export interface EntityLookup {
  /** The entity type, as in `inputEntities` and `outputEntities` (`playlist`). */
  readonly type: string;
  /**
   * The read tool's parameters and what fills them: `{ playlist_id: 'playlist_id' }`
   * (the entity's id field), `{ playlist_id: { ref: 'playlist' } }` (the call's
   * reference of type `playlist`). Every id field of the entity may appear at
   * most once. Empty for a list without filter.
   */
  readonly params: Readonly<Record<string, EntityLookupParam>>;
  /** Fixed parameters, such as a page size. */
  readonly const?: Readonly<Record<string, EntityLookupConst>>;
  /**
   * `one`: the answer is the record; `list`: the record is searched among the
   * entries of one page. Default: `list` when the entity's declared path
   * reads entries (`[]`), else `one`.
   */
  readonly result?: EntityLookupResult;
  /**
   * Only `list`: the page holds every record that could match (no paging, or
   * the parameters narrow it to the id). Then an id that is not on it does
   * not exist; without it, the subject is "not checkable".
   */
  readonly complete?: boolean;
}

/** How a preview value is shown. `count` counts an array (affected devices). */
export type ApprovalPreviewFormat = 'text' | 'number' | 'count' | 'date';

/** One shown value of a preview. */
export interface ApprovalPreviewField {
  /** A result path without index (`impact.devices`, `summary.title`). */
  readonly path: string;
  readonly label: LocalizedText;
  readonly format?: ApprovalPreviewFormat;
}

/**
 * A bounded preview of what an approved call would do, read from a source
 * the write call's arguments fill. The source must be a read tool: GET/HEAD,
 * a tool without a method that needs no approval, or one that declares
 * `lookupEffect: 'read'` (a POST dry-run whose body the `params` build).
 */
export interface ApprovalPreviewDeclaration {
  /** The source tool, by the name the model calls it or its definition id. */
  readonly tool: string;
  /** The source's parameters (path, query or body): an argument path of the write call, or `{ const }`. */
  readonly params: Readonly<Record<string, string | { readonly const: EntityLookupConst | null }>>;
  /** At most three. */
  readonly fields: ReadonlyArray<ApprovalPreviewField>;
}

/** What happens when a subject cannot be checked (timeout, 5xx, 429, source not available, limit). */
export type ApprovalSubjectUnavailable = 'warn' | 'block';
/** What a 403 of the source means: `deny` (default, as a 404), or `warn` (a card with "not checkable"). */
export type ApprovalSubjectForbidden = 'deny' | 'warn';
/** Whether an approved call checks its subjects again before it runs. */
export type ApprovalSubjectRecheck = 'none' | 'exists' | 'unchanged';

/** Per write tool: which declared arguments are looked up, the preview and the failure behaviour. */
export interface ApprovalSubjectDeclaration {
  /**
   * Arguments of `inputEntities` to look up, by their argument path (a
   * composite key's paths joined with `,`). Default: every reference with
   * role `target` or `parent`; a `reference` only when named here.
   */
  readonly refs?: ReadonlyArray<string>;
  readonly preview?: ApprovalPreviewDeclaration;
  /** Default `warn`: a card with a warning. `block`: no card, the model gets `approval_subject_unavailable`. */
  readonly onUnavailable?: ApprovalSubjectUnavailable;
  /** Default `deny`. */
  readonly onForbidden?: ApprovalSubjectForbidden;
  /** Default `none`. */
  readonly recheck?: ApprovalSubjectRecheck;
}

/** `false` turns the server lookup off for one tool. */
export type ApprovalSubjectOption = false | ApprovalSubjectDeclaration;

/** The one effect a lookup or preview source can declare: its calls change nothing. */
export type LookupEffect = 'read';

/** Lookups per read tool, at most. */
export const MAX_ENTITY_LOOKUPS = 8;
/** Preview fields per tool, at most. */
export const MAX_PREVIEW_FIELDS = 3;
/** Parameters per lookup or preview, at most. */
const MAX_PARAMS = 16;
const PARAM_PATTERN = /^[A-Za-z_$][\w$-]{0,127}$/;
const FIELD_PATTERN = /^[A-Za-z_$][\w$-]{0,63}$/;
const ARG_PATH_PATTERN = /^[A-Za-z_$][\w$-]{0,63}(?:\.[A-Za-z_$][\w$-]{0,63}){0,7}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z_$][\w$.:-]{0,199}$/;
const PREVIEW_PATH_PATTERN = /^[A-Za-z_$][\w$-]{0,63}(?:\.[A-Za-z_$][\w$-]{0,63}){0,7}$/;
const RESULTS: ReadonlySet<string> = new Set(['one', 'list']);
const FORMATS: ReadonlySet<string> = new Set(['text', 'number', 'count', 'date']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): string | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `has unknown keys (${extra.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 64))).join(', ')})` : undefined;
}

function isConst(value: unknown): value is EntityLookupConst {
  return typeof value === 'string' ? value.length <= 200 : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** Whether a value is a `LocalizedText` of at most 200 characters per language. */
export function isLocalizedLabel(value: unknown): value is LocalizedText {
  if (typeof value === 'string') return value.trim() !== '' && value.length <= 200;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= MAX_TEXT_LANGUAGES
    && entries.every(([tag, text]) => isLanguageTag(tag) && typeof text === 'string' && text.trim() !== '' && text.length <= 200);
}

/** What is wrong with an `EntityLookup`, in words without its values; undefined when it is valid. */
export function entityLookupIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  const extra = unknownKeys(value, ['type', 'params', 'const', 'result', 'complete']);
  if (extra) return extra;
  if (typeof value.type !== 'string' || !ENTITY_TYPE_PATTERN.test(value.type)) {
    return 'has no type: a lower-case name of at most 64 characters (letters, digits, _, . and -)';
  }
  if (!isRecord(value.params)) return 'has no params: an object of parameter names';
  const params = Object.entries(value.params);
  if (params.length > MAX_PARAMS) return `has more than ${MAX_PARAMS} params`;
  const fields = new Set<string>();
  for (const [name, source] of params) {
    if (!PARAM_PATTERN.test(name)) return 'has a parameter name that is not a name';
    if (typeof source === 'string') {
      if (!FIELD_PATTERN.test(source)) return 'maps a parameter to something that is not an id field name';
      if (fields.has(source)) return 'maps two parameters to one id field';
      fields.add(source);
      continue;
    }
    if (!isRecord(source) || unknownKeys(source, ['ref']) || typeof source.ref !== 'string' || !ENTITY_TYPE_PATTERN.test(source.ref)) {
      return 'maps a parameter to something that is neither an id field nor { ref: <type> }';
    }
    if (source.ref === value.type) return 'maps a parameter to its own type by ref; name the id field instead';
  }
  if (value.const !== undefined) {
    if (!isRecord(value.const)) return 'has a const that is not an object';
    const entries = Object.entries(value.const);
    if (entries.length > MAX_PARAMS) return `has more than ${MAX_PARAMS} const values`;
    for (const [name, constant] of entries) {
      if (!PARAM_PATTERN.test(name)) return 'has a const name that is not a name';
      if (Object.prototype.hasOwnProperty.call(value.params, name)) return 'sets a parameter both in params and in const';
      if (!isConst(constant)) return 'has a const value that is not a string (at most 200 characters), a finite number or a boolean';
    }
  }
  if (value.result !== undefined && (typeof value.result !== 'string' || !RESULTS.has(value.result))) {
    return 'has a result that is neither one nor list';
  }
  if (value.complete !== undefined && typeof value.complete !== 'boolean') return 'has a complete that is not true or false';
  if (value.complete === true && value.result === 'one') return 'is complete, which only a list can be';
  return undefined;
}

/** What is wrong with a preview declaration; undefined when it is valid. */
export function approvalPreviewIssue(value: unknown): string | undefined {
  if (!isRecord(value)) return 'is not an object';
  const extra = unknownKeys(value, ['tool', 'params', 'fields']);
  if (extra) return extra;
  if (typeof value.tool !== 'string' || !TOOL_NAME_PATTERN.test(value.tool)) return 'has no tool name';
  if (!isRecord(value.params)) return 'has no params: an object of parameter names';
  const params = Object.entries(value.params);
  if (params.length > MAX_PARAMS) return `has more than ${MAX_PARAMS} params`;
  for (const [name, source] of params) {
    if (!PARAM_PATTERN.test(name)) return 'has a parameter name that is not a name';
    if (typeof source === 'string') {
      if (!ARG_PATH_PATTERN.test(source)) return 'fills a parameter from something that is not an argument path';
      continue;
    }
    if (!isRecord(source) || unknownKeys(source, ['const']) || !('const' in source)
      || !(source.const === null || isConst(source.const))) {
      return 'fills a parameter from something that is neither an argument path nor { const }';
    }
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > MAX_PREVIEW_FIELDS) {
    return `has no fields: a list of 1 to ${MAX_PREVIEW_FIELDS}`;
  }
  for (const field of value.fields) {
    if (!isRecord(field) || unknownKeys(field, ['path', 'label', 'format'])) return 'has a field that is not { path, label, format? }';
    if (typeof field.path !== 'string' || !PREVIEW_PATH_PATTERN.test(field.path)) return 'has a field path that is not a result path such as impact.devices';
    if (!isLocalizedLabel(field.label)) return 'has a field label that is not a text or a map of language tags to texts (at most 200 characters)';
    if (field.format !== undefined && (typeof field.format !== 'string' || !FORMATS.has(field.format))) {
      return 'has a field format that is not text, number, count or date';
    }
  }
  if (new Set((value.fields as Array<{ path: string }>).map((field) => field.path)).size !== value.fields.length) {
    return 'names a field path twice';
  }
  return undefined;
}

/** What is wrong with an `approvalSubject` option; undefined when it is valid. */
export function approvalSubjectIssue(value: unknown): string | undefined {
  if (value === false) return undefined;
  if (!isRecord(value)) return 'is neither false nor an object';
  const extra = unknownKeys(value, ['refs', 'preview', 'onUnavailable', 'onForbidden', 'recheck']);
  if (extra) return extra;
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs) || value.refs.length > 20) return 'has refs that are not a list of at most 20 argument paths';
    for (const ref of value.refs) {
      if (typeof ref !== 'string' || !ref.split(',').every((part) => ARG_PATH_PATTERN.test(part))) {
        return 'has a ref that is not an argument path (a composite key joined with ,)';
      }
    }
  }
  if (value.preview !== undefined) {
    const issue = approvalPreviewIssue(value.preview);
    if (issue) return `has a preview that ${issue}`;
  }
  if (value.onUnavailable !== undefined && value.onUnavailable !== 'warn' && value.onUnavailable !== 'block') {
    return 'has an onUnavailable that is neither warn nor block';
  }
  if (value.onForbidden !== undefined && value.onForbidden !== 'deny' && value.onForbidden !== 'warn') {
    return 'has an onForbidden that is neither deny nor warn';
  }
  if (value.recheck !== undefined && value.recheck !== 'none' && value.recheck !== 'exists' && value.recheck !== 'unchanged') {
    return 'has a recheck that is not none, exists or unchanged';
  }
  return undefined;
}

/** The lookups of an `entityLookup` option as a list (one object or a list). */
export function entityLookupsOf(value: EntityLookup | ReadonlyArray<EntityLookup> | undefined): EntityLookup[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as EntityLookup];
}

/** The valid lookups of a value (an invalid one is left out); undefined for none. */
export function validEntityLookups(value: unknown): EntityLookup[] | undefined {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const valid = (list.filter((entry) => entityLookupIssue(entry) === undefined) as EntityLookup[]).slice(0, MAX_ENTITY_LOOKUPS);
  return valid.length > 0 ? valid : undefined;
}

/** The `approvalSubject` option when valid, else undefined. */
export function validApprovalSubject(value: unknown): ApprovalSubjectOption | undefined {
  return value !== undefined && approvalSubjectIssue(value) === undefined ? value as ApprovalSubjectOption : undefined;
}

/**
 * Throws on an invalid `entityLookup`, `approvalSubject` or `lookupEffect`
 * (for `defineTool` and `endpointToolToTool`, like an invalid `outputEntities`).
 */
export function assertApprovalSubjectDeclarations(
  value: { entityLookup?: unknown; approvalSubject?: unknown; lookupEffect?: unknown },
  label: string,
): void {
  if (value.entityLookup !== undefined) {
    const list = Array.isArray(value.entityLookup) ? value.entityLookup : [value.entityLookup];
    if (list.length === 0 || list.length > MAX_ENTITY_LOOKUPS) {
      throw new Error(`${label}: entityLookup must be one lookup or a list of 1 to ${MAX_ENTITY_LOOKUPS}.`);
    }
    list.forEach((entry, index) => {
      const issue = entityLookupIssue(entry);
      if (issue) throw new Error(`${label}: entityLookup${Array.isArray(value.entityLookup) ? `[${index}]` : ''} ${issue}.`);
    });
    if (new Set(list.map((entry) => (entry as EntityLookup).type)).size !== list.length) {
      throw new Error(`${label}: entityLookup declares one entity type twice.`);
    }
  }
  if (value.approvalSubject !== undefined) {
    const issue = approvalSubjectIssue(value.approvalSubject);
    if (issue) throw new Error(`${label}: approvalSubject ${issue}.`);
  }
  if (value.lookupEffect !== undefined && value.lookupEffect !== 'read') {
    throw new Error(`${label}: lookupEffect can only be 'read'.`);
  }
}

// ============================================================================
// What the browser receives (`data-approval-subjects`, F1)
// ============================================================================

/** The UI stream part that carries the server's subjects of one approval request. */
export const APPROVAL_SUBJECTS_PART_TYPE = 'data-approval-subjects';
/** The version of the part's `data`. */
export const APPROVAL_SUBJECTS_PART_VERSION = 1;

/** Why a subject could not be checked. */
export type ApprovalSubjectUncheckedReason =
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'limit'
  | 'source_unavailable'
  | 'invalid_response'
  | 'mismatch'
  | 'not_in_page'
  | 'forbidden';

export const APPROVAL_SUBJECT_UNCHECKED_REASONS: ReadonlyArray<ApprovalSubjectUncheckedReason> = [
  'timeout', 'unavailable', 'rate_limited', 'limit', 'source_unavailable', 'invalid_response', 'mismatch', 'not_in_page', 'forbidden',
];

/** One record a call names, as the server found it. Values are looked up and untrusted: plain text only. */
export interface ServerApprovalSubject {
  /** The declared entity type (`playlist`). */
  readonly type: string;
  readonly role: 'target' | 'parent' | 'reference';
  /** The id as the call carries it, a composite key's parts joined with `/`. */
  readonly id: string;
  /** The id by field: one entry, or one per part of a composite key. */
  readonly ids: Readonly<Record<string, string>>;
  /** The argument path(s) of the id (`playlist_id`, `channel,rev`). */
  readonly path: string;
  /**
   * `named`: found with a name; `seen`: found without a name (maybe with a
   * fallback); `ambiguous`: several records matched (`candidates`);
   * `unknown`: not checkable (`check: 'unchecked'`, `reason`).
   */
  readonly status: 'named' | 'seen' | 'ambiguous' | 'unknown';
  readonly check: 'found' | 'unchecked';
  readonly reason?: ApprovalSubjectUncheckedReason;
  readonly name?: string;
  readonly fallbackField?: string;
  readonly fallbackValue?: string | number;
  readonly candidates?: ReadonlyArray<string>;
  readonly idKind: 'opaque' | 'speaking';
}

/** A preview value as shown. */
export interface ApprovalPreviewValue {
  readonly key: string;
  readonly label: LocalizedText;
  readonly value: string | number | boolean;
  readonly format?: ApprovalPreviewFormat;
}

/** The preview of a call: found values, or not checkable. */
export interface ApprovalPreviewData {
  readonly check: 'found' | 'unchecked';
  readonly reason?: ApprovalSubjectUncheckedReason;
  readonly fields: ReadonlyArray<ApprovalPreviewValue>;
}

/** `data` of a `data-approval-subjects` part. */
export interface ApprovalSubjectsPartData {
  readonly v: typeof APPROVAL_SUBJECTS_PART_VERSION;
  readonly toolCallId: string;
  readonly subjects: ReadonlyArray<ServerApprovalSubject>;
  readonly preview?: ApprovalPreviewData;
}

/** Longest looked-up text on the card. */
export const MAX_SUBJECT_TEXT_LENGTH = 200;
/** Subjects per part, at most (the server sends no more than its per-call limit). */
const MAX_PART_SUBJECTS = 16;

/**
 * Control characters (C0, DEL, C1), bidirectional overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), the bidi marks (U+200E, U+200F, U+061C),
 * zero-width joiners and the BOM, and line or paragraph separators.
 */
const UNSAFE_TEXT = new RegExp(`[${[
  [0x00, 0x1f], [0x7f, 0x9f], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
].map(([from, to]) => `\\u${from!.toString(16).padStart(4, '0')}-\\u${to!.toString(16).padStart(4, '0')}`).join('')}]`, 'g');

/**
 * A looked-up value as the card may show it: plain text without control or
 * bidi characters and line breaks (each run becomes one space), trimmed, at
 * most 200 characters (cut with `…`). Undefined when nothing is left.
 */
export function sanitizeSubjectText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > MAX_SUBJECT_TEXT_LENGTH ? `${chars.slice(0, MAX_SUBJECT_TEXT_LENGTH - 1).join('')}…` : text;
}

function sanitizedValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return sanitizeSubjectText(value);
}

const SUBJECT_STATUSES: ReadonlySet<string> = new Set(['named', 'seen', 'ambiguous', 'unknown']);
const ROLES: ReadonlySet<string> = new Set(['target', 'parent', 'reference']);
const REASONS: ReadonlySet<string> = new Set(APPROVAL_SUBJECT_UNCHECKED_REASONS);

function parseSubject(value: unknown): ServerApprovalSubject | undefined {
  if (!isRecord(value)) return undefined;
  const { type, role, status, check, reason, idKind } = value;
  if (typeof type !== 'string' || !ENTITY_TYPE_PATTERN.test(type)) return undefined;
  if (typeof role !== 'string' || !ROLES.has(role)) return undefined;
  if (typeof status !== 'string' || !SUBJECT_STATUSES.has(status)) return undefined;
  if (check !== 'found' && check !== 'unchecked') return undefined;
  if ((check === 'unchecked') !== (status === 'unknown')) return undefined;
  if (reason !== undefined && (typeof reason !== 'string' || !REASONS.has(reason))) return undefined;
  if (idKind !== 'opaque' && idKind !== 'speaking') return undefined;
  const id = sanitizeSubjectText(value.id);
  const path = typeof value.path === 'string' && value.path.length <= 600 ? value.path : undefined;
  if (id === undefined || path === undefined || !isRecord(value.ids)) return undefined;
  const ids: Record<string, string> = Object.create(null);
  const idEntries = Object.entries(value.ids);
  if (idEntries.length === 0 || idEntries.length > 4) return undefined;
  for (const [field, part] of idEntries) {
    const text = sanitizeSubjectText(part);
    if (!FIELD_PATTERN.test(field) || text === undefined) return undefined;
    ids[field] = text;
  }
  const name = value.name === undefined ? undefined : sanitizeSubjectText(value.name);
  if (status === 'named' && name === undefined) return undefined;
  const fallbackValue = value.fallbackValue === undefined ? undefined : sanitizedValue(value.fallbackValue);
  const fallbackField = typeof value.fallbackField === 'string' && FIELD_PATTERN.test(value.fallbackField) ? value.fallbackField : undefined;
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.slice(0, 10).map(sanitizeSubjectText).filter((text): text is string => text !== undefined)
    : undefined;
  return {
    type,
    role: role as ServerApprovalSubject['role'],
    id,
    ids,
    path,
    status: status as ServerApprovalSubject['status'],
    check,
    ...(reason !== undefined ? { reason: reason as ApprovalSubjectUncheckedReason } : {}),
    ...(name !== undefined && status !== 'unknown' ? { name } : {}),
    ...(fallbackField !== undefined && fallbackValue !== undefined && typeof fallbackValue !== 'boolean'
      ? { fallbackField, fallbackValue }
      : {}),
    ...(candidates && candidates.length > 0 ? { candidates } : {}),
    idKind,
  };
}

function parsePreview(value: unknown): ApprovalPreviewData | undefined {
  if (!isRecord(value) || (value.check !== 'found' && value.check !== 'unchecked') || !Array.isArray(value.fields)) return undefined;
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !REASONS.has(value.reason))) return undefined;
  const fields: ApprovalPreviewValue[] = [];
  for (const field of value.fields.slice(0, MAX_PREVIEW_FIELDS)) {
    if (!isRecord(field) || typeof field.key !== 'string' || !PREVIEW_PATH_PATTERN.test(field.key) || !isLocalizedLabel(field.label)) continue;
    const shown = sanitizedValue(field.value);
    if (shown === undefined) continue;
    const format = typeof field.format === 'string' && FORMATS.has(field.format) ? field.format as ApprovalPreviewFormat : undefined;
    fields.push({ key: field.key, label: field.label, value: shown, ...(format ? { format } : {}) });
  }
  return { check: value.check, ...(value.reason !== undefined ? { reason: value.reason as ApprovalSubjectUncheckedReason } : {}), fields };
}

/**
 * The `data` of a `data-approval-subjects` part when it has the expected
 * shape, every text sanitized; undefined otherwise. The browser reads the
 * server's part through this (it is stored in the client's history, so it is
 * checked like any client data). The server never reads it back: what
 * counts there is only the digest signed into the approval id.
 */
export function parseApprovalSubjectsPart(value: unknown): ApprovalSubjectsPartData | undefined {
  if (!isRecord(value) || value.v !== APPROVAL_SUBJECTS_PART_VERSION) return undefined;
  if (typeof value.toolCallId !== 'string' || value.toolCallId === '' || value.toolCallId.length > 200) return undefined;
  if (!Array.isArray(value.subjects) || value.subjects.length > MAX_PART_SUBJECTS) return undefined;
  const subjects: ServerApprovalSubject[] = [];
  for (const entry of value.subjects) {
    const subject = parseSubject(entry);
    if (subject) subjects.push(subject);
  }
  const preview = value.preview === undefined ? undefined : parsePreview(value.preview);
  return { v: APPROVAL_SUBJECTS_PART_VERSION, toolCallId: value.toolCallId, subjects, ...(preview ? { preview } : {}) };
}
