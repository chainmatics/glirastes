/**
 * Declarative chat interactions: `@` entities and `/` commands a target app
 * offers in its chat. `glirastes tools refresh` derives them from the code
 * (`chatInteractions` in the generated module), `.glirastes/chat-interactions.json`
 * or app code override them, and React and `<glirastes-chat>` turn them into
 * completion providers. Plain JSON, dependency-free and bounded: the same
 * data travels from the generator through the chat handler to the browser.
 */
import {
  CHAT_COMMAND_ID_PATTERN,
  CHAT_COMMAND_TOOL_PATTERN,
  serializeChatCommandArgs,
} from './chat-command.js';

export type ChatLocaleCode = 'de' | 'en';
/** One text, or one per language; `en` is the fallback. */
export type ChatText = string | { readonly de?: string; readonly en?: string };

export interface ChatInteractionArg {
  /** Argument name, a dotted path for nested values (`params.taskId`). */
  readonly name: string;
  readonly label: ChatText;
  readonly required?: boolean;
  /** The value is the id of an entity of this type, picked with `@`. */
  readonly entity?: string;
  /** Closed set of values. */
  readonly options?: ReadonlyArray<string>;
}

/** Runs a catalog tool directly, without a model call. `ui` marks a generated UI tool. */
export interface ChatToolRun {
  readonly kind: 'tool' | 'ui';
  /** Catalog definition id, e.g. `ui.navigate`. */
  readonly tool: string;
  /** Fixed arguments, merged below the user's arguments. */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Inserts a prepared instruction that the model carries out. */
export interface ChatPromptRun {
  readonly kind: 'prompt';
  readonly prompt: ChatText;
}

export type ChatCommandRun = ChatToolRun | ChatPromptRun;

export interface ChatCommandData {
  readonly id: string;
  readonly label: ChatText;
  readonly description?: ChatText;
  readonly keywords?: ReadonlyArray<string>;
  /** Icon name (`[a-z0-9-]`), resolved by the app's theme. */
  readonly icon?: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatCommandRun;
}

/** Entity search through a read endpoint of the app, with the user's session. */
export interface ChatEntitySearchData {
  /** The read tool behind the search; the chat handler hides the search when it is not allowed. */
  readonly tool: string;
  /** App-internal collection path, e.g. `/api/tasks`. */
  readonly path: string;
  readonly queryParam: string;
  /** Where the item list sits in the response; empty when the response is the list. */
  readonly itemsPath: ReadonlyArray<string>;
  readonly idField: string;
  readonly labelField: string;
  readonly descriptionField?: string;
  readonly limitParam?: string;
}

export interface ChatEntityActionData {
  readonly id: string;
  readonly label: ChatText;
  /** Argument that receives the entity id (dotted path). */
  readonly entityArg: string;
  readonly args?: ReadonlyArray<ChatInteractionArg>;
  readonly run: ChatToolRun;
}

export interface ChatEntityData {
  /** Mention type, e.g. `task`. */
  readonly type: string;
  readonly label: ChatText;
  readonly icon?: string;
  readonly search?: ChatEntitySearchData;
  readonly actions?: ReadonlyArray<ChatEntityActionData>;
}

export interface ChatInteractionsData {
  readonly schemaVersion: 1;
  readonly entities: ReadonlyArray<ChatEntityData>;
  readonly commands: ReadonlyArray<ChatCommandData>;
}

export interface ChatCommandOverride extends Partial<Omit<ChatCommandData, 'id'>> {
  readonly hidden?: boolean;
}

export interface ChatEntityActionOverride extends Partial<Omit<ChatEntityActionData, 'id'>> {
  readonly hidden?: boolean;
}

export interface ChatEntityOverride extends Partial<Omit<ChatEntityData, 'type' | 'actions'>> {
  readonly hidden?: boolean;
  readonly actions?: Readonly<Record<string, ChatEntityActionOverride>>;
}

/** `.glirastes/chat-interactions.json`: written by people or skills, never by the generator. */
export interface ChatInteractionOverrides {
  readonly schemaVersion: 1;
  readonly entities?: Readonly<Record<string, ChatEntityOverride>>;
  readonly commands?: Readonly<Record<string, ChatCommandOverride>>;
}

export const CHAT_INTERACTION_LIMITS = Object.freeze({
  entities: 50,
  commands: 300,
  actionsPerEntity: 20,
  args: 12,
  options: 50,
  keywords: 20,
  labelLength: 200,
  descriptionLength: 500,
  promptLength: 2_000,
});

export const CHAT_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const ARG_SEGMENT = /^[A-Za-z_$][\w$-]{0,63}$/;
const ICON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export class ChatInteractionsError extends Error {
  constructor(readonly issues: ReadonlyArray<string>) {
    super(`Invalid chat interactions: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ChatInteractionsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a dotted argument path that can never reach an object prototype. */
export function isChatArgumentPath(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > 200) return false;
  const segments = name.split('.');
  return segments.length <= 4
    && segments.every((segment) => ARG_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment));
}

/** The text in `locale`, falling back to English, then German. */
export function chatText(text: ChatText | undefined, locale: ChatLocaleCode = 'en'): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? text.de ?? '';
}

type Issues = string[];

function fail(issues: Issues, path: string, message: string): undefined {
  issues.push(`${path}: ${message}`);
  return undefined;
}

function checkKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>, path: string, issues: Issues): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key}: unknown field`);
  }
}

function boundedString(value: unknown, max: number, path: string, issues: Issues): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B-\u001F]/.test(value)) {
    return fail(issues, path, `a non-blank string of at most ${max} characters`);
  }
  return value;
}

function text(value: unknown, max: number, path: string, issues: Issues): ChatText | undefined {
  if (typeof value === 'string') return boundedString(value, max, path, issues);
  if (!isRecord(value)) return fail(issues, path, 'a string or { de, en }');
  checkKeys(value, ['de', 'en'], path, issues);
  const result: { de?: string; en?: string } = {};
  for (const language of ['de', 'en'] as const) {
    if (value[language] === undefined) continue;
    const entry = boundedString(value[language], max, `${path}.${language}`, issues);
    if (entry !== undefined) result[language] = entry;
  }
  if (result.de === undefined && result.en === undefined) return fail(issues, path, 'needs de or en');
  return result;
}

function pattern(value: unknown, regex: RegExp, path: string, issues: Issues): string | undefined {
  return typeof value === 'string' && regex.test(value) ? value : fail(issues, path, `must match ${regex}`);
}

function list<T>(
  value: unknown,
  max: number,
  path: string,
  issues: Issues,
  item: (entry: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return fail(issues, path, `an array of at most ${max} entries`);
  const result: T[] = [];
  value.forEach((entry, index) => {
    const parsed = item(entry, `${path}[${index}]`);
    if (parsed !== undefined) result.push(parsed);
  });
  return result;
}

function fixedArgs(value: unknown, path: string, issues: Issues): Record<string, unknown> | undefined {
  if (serializeChatCommandArgs(value) === undefined) return fail(issues, path, 'a JSON object of at most 2000 characters');
  return value as Record<string, unknown>;
}

function arg(value: unknown, path: string, issues: Issues): ChatInteractionArg | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['name', 'label', 'required', 'entity', 'options'], path, issues);
  if (!isChatArgumentPath(value.name)) return fail(issues, `${path}.name`, 'a dotted argument path');
  const label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.required !== undefined && typeof value.required !== 'boolean') fail(issues, `${path}.required`, 'a boolean');
  const entity = value.entity === undefined ? undefined : pattern(value.entity, CHAT_ENTITY_TYPE_PATTERN, `${path}.entity`, issues);
  const options = value.options === undefined
    ? undefined
    : list(value.options, CHAT_INTERACTION_LIMITS.options, `${path}.options`, issues,
      (entry, entryPath) => boundedString(entry, 100, entryPath, issues));
  if (label === undefined) return undefined;
  return {
    name: value.name,
    label,
    ...(value.required === true ? { required: true } : {}),
    ...(entity ? { entity } : {}),
    ...(options ? { options } : {}),
  };
}

function args(value: unknown, path: string, issues: Issues): ChatInteractionArg[] | undefined {
  const parsed = list(value, CHAT_INTERACTION_LIMITS.args, path, issues, (entry, entryPath) => arg(entry, entryPath, issues));
  if (parsed && new Set(parsed.map((entry) => entry.name)).size !== parsed.length) {
    return fail(issues, path, 'argument names must be unique');
  }
  return parsed;
}

function toolRun(value: unknown, path: string, issues: Issues): ChatToolRun | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['kind', 'tool', 'args'], path, issues);
  if (value.kind !== 'tool' && value.kind !== 'ui') return fail(issues, `${path}.kind`, "'tool' or 'ui'");
  const tool = pattern(value.tool, CHAT_COMMAND_TOOL_PATTERN, `${path}.tool`, issues);
  const fixed = value.args === undefined ? undefined : fixedArgs(value.args, `${path}.args`, issues);
  if (tool === undefined) return undefined;
  return { kind: value.kind, tool, ...(fixed ? { args: fixed } : {}) };
}

function commandRun(value: unknown, path: string, issues: Issues): ChatCommandRun | undefined {
  if (isRecord(value) && value.kind === 'prompt') {
    checkKeys(value, ['kind', 'prompt'], path, issues);
    const prompt = text(value.prompt, CHAT_INTERACTION_LIMITS.promptLength, `${path}.prompt`, issues);
    return prompt === undefined ? undefined : { kind: 'prompt', prompt };
  }
  return toolRun(value, path, issues);
}

const COMMAND_FIELDS = ['label', 'description', 'keywords', 'icon', 'args', 'run'] as const;

function commandFields(value: Record<string, unknown>, path: string, issues: Issues): Partial<ChatCommandData> {
  const result: Record<string, unknown> = {};
  if (value.label !== undefined) result.label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.description !== undefined) {
    result.description = text(value.description, CHAT_INTERACTION_LIMITS.descriptionLength, `${path}.description`, issues);
  }
  if (value.keywords !== undefined) {
    result.keywords = list(value.keywords, CHAT_INTERACTION_LIMITS.keywords, `${path}.keywords`, issues,
      (entry, entryPath) => boundedString(entry, 60, entryPath, issues));
  }
  if (value.icon !== undefined) result.icon = pattern(value.icon, ICON, `${path}.icon`, issues);
  if (value.args !== undefined) result.args = args(value.args, `${path}.args`, issues);
  if (value.run !== undefined) result.run = commandRun(value.run, `${path}.run`, issues);
  return result as Partial<ChatCommandData>;
}

function command(value: unknown, path: string, issues: Issues): ChatCommandData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['id', ...COMMAND_FIELDS], path, issues);
  const id = pattern(value.id, CHAT_COMMAND_ID_PATTERN, `${path}.id`, issues);
  const fields = commandFields(value, path, issues);
  if (value.label === undefined) fail(issues, `${path}.label`, 'required');
  if (value.run === undefined) fail(issues, `${path}.run`, 'required');
  if (id === undefined || fields.label === undefined || fields.run === undefined) return undefined;
  return { id, ...fields } as ChatCommandData;
}

function search(value: unknown, path: string, issues: Issues): ChatEntitySearchData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['tool', 'path', 'queryParam', 'itemsPath', 'idField', 'labelField', 'descriptionField', 'limitParam'], path, issues);
  const tool = pattern(value.tool, CHAT_COMMAND_TOOL_PATTERN, `${path}.tool`, issues);
  const route = typeof value.path === 'string' && value.path.startsWith('/') && !value.path.startsWith('//')
    && value.path.length <= 512 && !/[?#\\:\s]/.test(value.path)
    && !value.path.split('/').some((segment) => segment === '.' || segment === '..')
    ? value.path
    : fail(issues, `${path}.path`, 'an app-internal path without parameters');
  const field = (key: string) => pattern(value[key], FIELD, `${path}.${key}`, issues);
  const queryParam = field('queryParam');
  const idField = field('idField');
  const labelField = field('labelField');
  const descriptionField = value.descriptionField === undefined ? undefined : field('descriptionField');
  const limitParam = value.limitParam === undefined ? undefined : field('limitParam');
  const itemsPath = list(value.itemsPath, 4, `${path}.itemsPath`, issues,
    (entry, entryPath) => pattern(entry, FIELD, entryPath, issues));
  if (!tool || !route || !queryParam || !idField || !labelField || !itemsPath) return undefined;
  return {
    tool, path: route, queryParam, itemsPath, idField, labelField,
    ...(descriptionField ? { descriptionField } : {}),
    ...(limitParam ? { limitParam } : {}),
  };
}

const ACTION_FIELDS = ['label', 'entityArg', 'args', 'run'] as const;

function actionFields(value: Record<string, unknown>, path: string, issues: Issues): Partial<ChatEntityActionData> {
  const result: Record<string, unknown> = {};
  if (value.label !== undefined) result.label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  if (value.entityArg !== undefined) {
    result.entityArg = isChatArgumentPath(value.entityArg)
      ? value.entityArg
      : fail(issues, `${path}.entityArg`, 'a dotted argument path');
  }
  if (value.args !== undefined) result.args = args(value.args, `${path}.args`, issues);
  if (value.run !== undefined) result.run = toolRun(value.run, `${path}.run`, issues);
  return result as Partial<ChatEntityActionData>;
}

function action(value: unknown, path: string, issues: Issues): ChatEntityActionData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['id', ...ACTION_FIELDS], path, issues);
  const id = pattern(value.id, CHAT_COMMAND_ID_PATTERN, `${path}.id`, issues);
  const fields = actionFields(value, path, issues);
  for (const key of ['label', 'entityArg', 'run'] as const) {
    if (value[key] === undefined) fail(issues, `${path}.${key}`, 'required');
  }
  if (!id || fields.label === undefined || fields.entityArg === undefined || fields.run === undefined) return undefined;
  return { id, ...fields } as ChatEntityActionData;
}

function uniqueBy<T>(entries: ReadonlyArray<T>, key: (entry: T) => string, path: string, issues: Issues): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = key(entry);
    if (seen.has(value)) issues.push(`${path}: duplicate ${value}`);
    seen.add(value);
  }
}

function entity(value: unknown, path: string, issues: Issues): ChatEntityData | undefined {
  if (!isRecord(value)) return fail(issues, path, 'an object');
  checkKeys(value, ['type', 'label', 'icon', 'search', 'actions'], path, issues);
  const type = pattern(value.type, CHAT_ENTITY_TYPE_PATTERN, `${path}.type`, issues);
  const label = text(value.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
  const icon = value.icon === undefined ? undefined : pattern(value.icon, ICON, `${path}.icon`, issues);
  const parsedSearch = value.search === undefined ? undefined : search(value.search, `${path}.search`, issues);
  const actions = value.actions === undefined
    ? undefined
    : list(value.actions, CHAT_INTERACTION_LIMITS.actionsPerEntity, `${path}.actions`, issues,
      (entry, entryPath) => action(entry, entryPath, issues));
  if (actions) uniqueBy(actions, (entry) => entry.id, `${path}.actions`, issues);
  if (!type || label === undefined) return undefined;
  return {
    type, label,
    ...(icon ? { icon } : {}),
    ...(parsedSearch ? { search: parsedSearch } : {}),
    ...(actions ? { actions } : {}),
  };
}

/** Validates interaction data strictly; throws `ChatInteractionsError` listing every issue. */
export function parseChatInteractions(value: unknown): ChatInteractionsData {
  const issues: Issues = [];
  if (!isRecord(value)) throw new ChatInteractionsError(['$: an object']);
  checkKeys(value, ['schemaVersion', 'entities', 'commands'], '$', issues);
  if (value.schemaVersion !== 1) issues.push('$.schemaVersion: must be 1');
  const entities = list(value.entities, CHAT_INTERACTION_LIMITS.entities, '$.entities', issues,
    (entry, path) => entity(entry, path, issues)) ?? [];
  const commands = list(value.commands, CHAT_INTERACTION_LIMITS.commands, '$.commands', issues,
    (entry, path) => command(entry, path, issues)) ?? [];
  uniqueBy(entities, (entry) => entry.type, '$.entities', issues);
  uniqueBy(commands, (entry) => entry.id, '$.commands', issues);
  if (issues.length > 0) throw new ChatInteractionsError(issues);
  return { schemaVersion: 1, entities, commands };
}

function overrideMap<T>(
  value: unknown,
  path: string,
  keyPattern: RegExp,
  issues: Issues,
  entry: (value: Record<string, unknown>, path: string) => T,
): Record<string, T> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail(issues, path, 'an object');
  const result: Record<string, T> = {};
  for (const [key, patch] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      issues.push(`${path}.${key}: invalid key`);
      continue;
    }
    if (!isRecord(patch)) {
      issues.push(`${path}.${key}: an object`);
      continue;
    }
    if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean') issues.push(`${path}.${key}.hidden: a boolean`);
    result[key] = entry(patch, `${path}.${key}`);
  }
  return result;
}

/** Validates `.glirastes/chat-interactions.json`; throws `ChatInteractionsError`. */
export function parseChatInteractionOverrides(value: unknown): ChatInteractionOverrides {
  const issues: Issues = [];
  if (!isRecord(value)) throw new ChatInteractionsError(['$: an object']);
  checkKeys(value, ['schemaVersion', 'entities', 'commands'], '$', issues);
  if (value.schemaVersion !== 1) issues.push('$.schemaVersion: must be 1');
  const commands = overrideMap(value.commands, '$.commands', CHAT_COMMAND_ID_PATTERN, issues, (patch, path) => {
    checkKeys(patch, ['hidden', ...COMMAND_FIELDS], path, issues);
    return { ...(patch.hidden === true ? { hidden: true } : {}), ...commandFields(patch, path, issues) };
  });
  const entities = overrideMap(value.entities, '$.entities', CHAT_ENTITY_TYPE_PATTERN, issues, (patch, path) => {
    checkKeys(patch, ['hidden', 'label', 'icon', 'search', 'actions'], path, issues);
    const result: Record<string, unknown> = patch.hidden === true ? { hidden: true } : {};
    if (patch.label !== undefined) result.label = text(patch.label, CHAT_INTERACTION_LIMITS.labelLength, `${path}.label`, issues);
    if (patch.icon !== undefined) result.icon = pattern(patch.icon, ICON, `${path}.icon`, issues);
    if (patch.search !== undefined) result.search = search(patch.search, `${path}.search`, issues);
    const actions = overrideMap(patch.actions, `${path}.actions`, CHAT_COMMAND_ID_PATTERN, issues, (actionPatch, actionPath) => {
      checkKeys(actionPatch, ['hidden', ...ACTION_FIELDS], actionPath, issues);
      return { ...(actionPatch.hidden === true ? { hidden: true } : {}), ...actionFields(actionPatch, actionPath, issues) };
    });
    if (actions) result.actions = actions;
    return result as ChatEntityOverride;
  });
  if (issues.length > 0) throw new ChatInteractionsError(issues);
  return {
    schemaVersion: 1,
    ...(entities ? { entities } : {}),
    ...(commands ? { commands } : {}),
  };
}

function withoutHidden<T extends { hidden?: boolean }>(patch: T): Omit<T, 'hidden'> {
  const { hidden: _hidden, ...rest } = patch;
  return rest;
}

function hasFields(patch: object, required: ReadonlyArray<string>): boolean {
  return required.every((key) => (patch as Record<string, unknown>)[key] !== undefined);
}

/**
 * Applies overrides to derived data: a patch replaces the fields it names,
 * `hidden: true` removes the entry, and a complete entry under a new id or
 * type is added (a command needs `label` and `run`, an action `label`,
 * `entityArg` and `run`, an entity `label` and a `search` or an action). A
 * patch under an id or type that is not derived and is no complete entry is
 * a stale patch, typically for a tool a refresh no longer derives: it is
 * ignored, with one console warning naming it, so the chat route still loads
 * and the entry keeps nothing. The result is validated again.
 */
export function mergeChatInteractions(
  base: ChatInteractionsData,
  overrides: ChatInteractionOverrides | undefined,
): ChatInteractionsData {
  if (!overrides) return parseChatInteractions(base);
  const ignored: string[] = [];
  const commandPatches = overrides.commands ?? {};
  const commands: unknown[] = base.commands
    .filter((entry) => commandPatches[entry.id]?.hidden !== true)
    .map((entry) => ({ ...entry, ...withoutHidden(commandPatches[entry.id] ?? {}) }));
  const known = new Set(base.commands.map((entry) => entry.id));
  for (const [id, patch] of Object.entries(commandPatches)) {
    if (known.has(id) || patch.hidden === true) continue;
    if (hasFields(patch, ['label', 'run'])) commands.push({ id, ...withoutHidden(patch) });
    else ignored.push(`commands.${id}`);
  }
  const entityPatches = overrides.entities ?? {};
  const mergeActions = (
    actions: ReadonlyArray<ChatEntityActionData>,
    patches: Readonly<Record<string, ChatEntityActionOverride>>,
    path: string,
    stale: string[],
  ) => {
    const merged: unknown[] = actions
      .filter((entry) => patches[entry.id]?.hidden !== true)
      .map((entry) => ({ ...entry, ...withoutHidden(patches[entry.id] ?? {}) }));
    const ids = new Set(actions.map((entry) => entry.id));
    for (const [id, patch] of Object.entries(patches)) {
      if (ids.has(id) || patch.hidden === true) continue;
      if (hasFields(patch, ['label', 'entityArg', 'run'])) merged.push({ id, ...withoutHidden(patch) });
      else stale.push(`${path}.actions.${id}`);
    }
    return merged;
  };
  const entities: unknown[] = base.entities
    .filter((entry) => entityPatches[entry.type]?.hidden !== true)
    .map((entry) => {
      const patch = entityPatches[entry.type];
      if (!patch) return entry;
      const { actions: actionPatches, ...fields } = withoutHidden(patch);
      const { actions: current, ...rest } = entry;
      const actions = mergeActions(current ?? [], actionPatches ?? {}, `entities.${entry.type}`, ignored);
      return { ...rest, ...fields, ...(actions.length > 0 ? { actions } : {}) };
    });
  const types = new Set(base.entities.map((entry) => entry.type));
  for (const [type, patch] of Object.entries(entityPatches)) {
    if (types.has(type) || patch.hidden === true) continue;
    const { actions: actionPatches, ...fields } = withoutHidden(patch);
    const stale: string[] = [];
    const actions = mergeActions([], actionPatches ?? {}, `entities.${type}`, stale);
    if (hasFields(fields, ['label']) && (fields.search !== undefined || actions.length > 0)) {
      entities.push({ type, ...fields, ...(actions.length > 0 ? { actions } : {}) });
      ignored.push(...stale);
    } else {
      ignored.push(`entities.${type}`);
    }
  }
  if (ignored.length > 0) {
    console.warn(
      '[glirastes] .glirastes/chat-interactions.json: ignored patches for ids that are not derived '
      + `(any more) and are no complete entries: ${ignored.join(', ')}. Remove them.`,
    );
  }
  return parseChatInteractions({ schemaVersion: 1, entities, commands });
}
