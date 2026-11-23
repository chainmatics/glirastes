/**
 * Declared `@` mention sources (`.glirastes/tools.json` `mentions`), at
 * generation time: which read endpoint searches an entity type, checked
 * against the tool's contract and its declared identity. Field, type and
 * tool names only; an invalid entry is a finding and is ignored, it never
 * fails the refresh.
 *
 * @module
 */
import {
  CHAT_ENTITY_TYPE_PATTERN,
  ChatInteractionsError,
  parseChatInteractions,
  type ChatEntityAliases,
  type ChatEntitySearchData,
  type ChatText,
} from '../../contracts/chat-interactions.js';
import { entityIdFields, parseEntityPath, type OutputEntityDeclaration } from '../../contracts/entity-declaration.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { JsonSchemaLike, ToolContract, ToolFinding } from './types.js';

/** `.glirastes/tools.json` `mentions`, as the config schema keeps it (source entries checked here). */
export interface ChatMentionsConfig {
  /** `derived` (default): every search endpoint the generator recognises; `declared`: only `sources`. */
  policy?: 'derived' | 'declared';
  /** By entity type, in the order of the `@` menu groups. */
  sources?: Record<string, unknown>;
  /** Derived candidate types that are neither offered nor reported. */
  ignore?: string[];
  /** Types whose change to the declared identity type is acknowledged (no `mention-type-follows-identity`). */
  acknowledgedTypes?: string[];
}

/** One tool of the setup artifact with what a mention source needs of it. */
export interface MentionTool {
  definitionId: string;
  modelName: string;
  enabled: boolean;
  executionKind: string;
  method?: string;
  path?: string;
  contract?: ToolContract;
  outputEntities?: ReadonlyArray<OutputEntityDeclaration>;
}

/** A declared source that passed every check. */
export interface DeclaredMentionSource {
  type: string;
  tool: MentionTool;
  search: ChatEntitySearchData;
  label?: ChatText;
  aliases?: ChatEntityAliases;
}

export const SEARCH_LIMIT_PARAMS: ReadonlyArray<string> = ['limit', 'pageSize'];
export const SEARCH_DESCRIPTION_FIELDS: ReadonlyArray<string> = ['description', 'email', 'status', 'subtitle', 'summary'];
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const SOURCE_KEYS = [
  'tool', 'queryParam', 'labelField', 'idField', 'itemsPath', 'descriptionField', 'limitParam', 'label', 'aliases',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function schemaProperties(schema: JsonSchemaLike | undefined): Record<string, JsonSchemaLike> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties as Record<string, JsonSchemaLike> : {};
}

function typesOf(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  if (typeof schema.type === 'string') return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === 'string') : [];
}

function isListSchema(schema: unknown): boolean {
  return isRecord(schema) && (typesOf(schema).includes('array') || isRecord(schema.items));
}

/** Whether a response schema says anything about its shape; an empty or absent one cannot be checked. */
function isDescribed(schema: unknown): boolean {
  return isRecord(schema) && (schema.type !== undefined || schema.properties !== undefined || schema.items !== undefined);
}

/**
 * The item schema of the list at `itemsPath` (`[]` for a response that is
 * the list): `{ items }` when the schema has it, `'unknown'` when the
 * schema is not described that far, undefined when it says otherwise.
 */
export function listItemsAt(
  output: JsonSchemaLike | undefined,
  itemsPath: ReadonlyArray<string>,
): { items: JsonSchemaLike | undefined } | 'unknown' | undefined {
  if (!isDescribed(output)) return 'unknown';
  let node: unknown = output;
  for (const key of itemsPath) {
    if (!isRecord(node) || isListSchema(node)) return undefined;
    if (!isRecord(node.properties)) return 'unknown';
    if (!Object.hasOwn(node.properties, key)) return undefined;
    node = node.properties[key];
  }
  if (!isRecord(node) || !isListSchema(node)) return undefined;
  return { items: isRecord(node.items) ? node.items as JsonSchemaLike : undefined };
}

/** The list a response holds when a declaration names no path: the response itself, or its one list of objects. */
export function defaultItemsPath(output: JsonSchemaLike | undefined): string[] | undefined {
  if (isListSchema(output)) return [];
  const lists = Object.entries(schemaProperties(output))
    .filter(([name, schema]) => FIELD.test(name) && isListSchema(schema) && isRecord(schema.items));
  return lists.length === 1 ? [lists[0]![0]] : undefined;
}

/**
 * The list a declaration's path names as search `itemsPath`, or undefined
 * when it names no list of records the search can read: `playlists[]` →
 * `['playlists']`; `data[]` of a response that is the list → `[]` (a list
 * answer travels under `data`); no path → `defaultItemsPath`; `''` or
 * `data[].owner` → undefined.
 */
export function declarationItemsPath(
  declaration: Pick<OutputEntityDeclaration, 'path'>,
  output: JsonSchemaLike | undefined,
): string[] | undefined {
  if (declaration.path === undefined) return defaultItemsPath(output);
  const steps = parseEntityPath(declaration.path);
  if (!steps || steps.length === 0 || !steps.at(-1)!.each || steps.slice(0, -1).some((step) => step.each)) return undefined;
  const keys = steps.map((step) => step.key);
  if (isListSchema(output)) return keys.length === 1 && keys[0] === 'data' ? [] : undefined;
  // `data[]` of an undescribed response is either the list itself or its `data` property.
  if (!isDescribed(output) && keys.length === 1 && keys[0] === 'data') return undefined;
  return keys;
}

export function sameItemsPath(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function fieldSchema(items: JsonSchemaLike | undefined, field: string): { known: boolean; schema?: unknown } {
  const fields = schemaProperties(items);
  if (!isRecord(items) || !isRecord(items.properties)) return { known: false };
  return Object.hasOwn(fields, field) ? { known: true, schema: fields[field] } : { known: true };
}

/** Whether the field is a text in the item schema (a property whose type includes string). */
export function isTextField(items: JsonSchemaLike | undefined, field: string): boolean {
  const { schema } = fieldSchema(items, field);
  return isRecord(schema) && typesOf(schema).includes('string');
}

/** `/api/users` for `/api/users/search`: the path whose item endpoints become the entity's actions. */
export function collectionOf(path: string): string {
  return path.replace(/\/search\/?$/, '');
}

const SUBJECT = (type: string) => `${TOOLS_PATHS.config}#mentions.sources.${type}`;

/**
 * Checks the declared sources of `mentions.sources` against the tools, in
 * key order. Each invalid entry is one `mention-source-invalid` finding and
 * is left out; an entry whose type the tool does not declare by identity is
 * used with a `mention-source-undeclared-type` warning.
 */
export function resolveMentionSources(
  sources: Readonly<Record<string, unknown>> | undefined,
  tools: ReadonlyArray<MentionTool>,
): { sources: DeclaredMentionSource[]; findings: ToolFinding[] } {
  const findings: ToolFinding[] = [];
  const result: DeclaredMentionSource[] = [];
  const config = TOOLS_PATHS.config;
  for (const [type, raw] of Object.entries(sources ?? {})) {
    const shown = type.slice(0, 64);
    const subject = SUBJECT(shown);
    const at = `${config} mentions.sources.${shown}`;
    const invalid = (issue: string) => {
      findings.push(toolFinding('mention-source-invalid', 'warning', subject, `${at} ${issue}; it is ignored.`));
    };
    if (!CHAT_ENTITY_TYPE_PATTERN.test(type)) {
      invalid('is no entity type the chat can carry (a lower-case letter, then at most 39 letters, digits, _ or -)');
      continue;
    }
    if (!isRecord(raw)) {
      invalid('is not an object');
      continue;
    }
    const unknown = Object.keys(raw).filter((key) => !SOURCE_KEYS.includes(key));
    if (unknown.length > 0) {
      invalid(`has unknown keys (${unknown.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 64))).join(', ')})`);
      continue;
    }
    const fieldValue = (key: string): string | undefined | false => {
      const value = raw[key];
      if (value === undefined) return undefined;
      return typeof value === 'string' && FIELD.test(value) ? value : false;
    };
    const textKeys = ['tool', 'queryParam', 'labelField', 'idField', 'descriptionField', 'limitParam'] as const;
    const badKey = textKeys.find((key) => key !== 'tool' && fieldValue(key) === false);
    if (badKey) {
      invalid(`has a ${badKey} that is not a field name`);
      continue;
    }
    if (typeof raw.tool !== 'string' || raw.tool.length === 0) {
      invalid('names no tool (a definition id such as files.list or a model name such as files_list)');
      continue;
    }
    const tool = tools.find((candidate) => candidate.definitionId === raw.tool)
      ?? tools.find((candidate) => candidate.modelName === raw.tool);
    const toolName = raw.tool.slice(0, 200);
    if (!tool) {
      invalid(`names the tool ${toolName}, which is no generated tool`);
      continue;
    }
    if (tool.executionKind !== 'endpoint' || (tool.method !== 'GET' && tool.method !== 'HEAD')) {
      invalid(`names the tool ${tool.definitionId}, which is no read endpoint (GET or HEAD)`);
      continue;
    }
    if (!tool.path || tool.path.includes(':') || tool.path.includes('{')) {
      invalid(`names the tool ${tool.definitionId}, whose path has a parameter; the chat calls a static path with the query parameter`);
      continue;
    }
    if (!tool.enabled || !tool.contract) {
      invalid(`names the tool ${tool.definitionId}, which is disabled`);
      continue;
    }
    const query = new Set(tool.contract.params.query);
    const queryParam = fieldValue('queryParam');
    if (!queryParam) {
      invalid('has no queryParam (the query parameter that takes the search text)');
      continue;
    }
    if (!query.has(queryParam)) {
      invalid(`has the queryParam ${queryParam}, which is no query parameter of ${tool.definitionId}`);
      continue;
    }
    const explicitLimit = fieldValue('limitParam');
    if (explicitLimit && !query.has(explicitLimit)) {
      invalid(`has the limitParam ${explicitLimit}, which is no query parameter of ${tool.definitionId}`);
      continue;
    }
    let explicitItems: string[] | undefined;
    if (raw.itemsPath !== undefined) {
      if (!Array.isArray(raw.itemsPath) || raw.itemsPath.length > 4
        || !raw.itemsPath.every((key) => typeof key === 'string' && FIELD.test(key))) {
        invalid('has an itemsPath that is not a list of at most 4 field names ([] when the response is the list)');
        continue;
      }
      explicitItems = raw.itemsPath as string[];
    }
    if (raw.idField !== undefined && typeof raw.idField !== 'string') {
      invalid('has an idField that is not one field name; a composite id cannot be a mention source');
      continue;
    }

    // The tool's declared identity of the type: the one at the given list, else the only one.
    const output = tool.contract.output;
    const ofType = (tool.outputEntities ?? []).filter((declaration) => declaration.type === type);
    const declaration = explicitItems
      ? ofType.find((entry) => {
        const path = declarationItemsPath(entry, output);
        return path !== undefined && sameItemsPath(path, explicitItems!);
      }) ?? (ofType.length === 1 && ofType[0]!.path === undefined ? ofType[0] : undefined)
      : ofType.length === 1 ? ofType[0] : ofType.find((entry) => declarationItemsPath(entry, output) !== undefined);
    if (declaration && entityIdFields(declaration).length > 1) {
      invalid(`names ${tool.definitionId}, whose identity declares ${type} with a composite id (${entityIdFields(declaration).join(', ')}); a composite id cannot be a mention source`);
      continue;
    }
    const itemsPath = explicitItems ?? (declaration ? declarationItemsPath(declaration, output) : defaultItemsPath(output));
    if (!itemsPath) {
      invalid(declaration
        ? `needs an itemsPath: the identity of ${tool.definitionId} places ${type} at ${declaration.path === undefined ? 'no path' : declaration.path || 'the result'}, which is no list the search can read`
        : `needs an itemsPath: the response of ${tool.definitionId} is no list and has not exactly one list of objects`);
      continue;
    }
    const idField = fieldValue('idField') || (declaration ? entityIdFields(declaration)[0] : undefined);
    const labelField = fieldValue('labelField') || declaration?.name;
    if (!idField || !labelField) {
      const missing = [...(!idField ? ['idField'] : []), ...(!labelField ? ['labelField'] : [])].join(' and ');
      invalid(declaration
        ? `needs ${missing}: the identity of ${tool.definitionId} declares ${type} without a name field`
        : `needs ${missing}: ${tool.definitionId} does not declare ${type} by identity, so nothing gives ${missing === 'idField' ? 'it' : 'them'}`);
      continue;
    }
    const list = listItemsAt(output, itemsPath);
    if (list === undefined) {
      invalid(`has the itemsPath ${JSON.stringify(itemsPath)}, which is no list in the response schema of ${tool.definitionId}`);
      continue;
    }
    const items = list === 'unknown' ? undefined : list.items;
    const fieldIssue = (key: string, field: string, text: boolean): string | undefined => {
      const found = fieldSchema(items, field);
      if (!found.known) return undefined;
      if (found.schema === undefined) return `has the ${key} ${field}, which the items of the response schema do not have`;
      if (text && typesOf(found.schema).length > 0 && !typesOf(found.schema).includes('string')) {
        return `has the ${key} ${field}, which is no text in the response schema`;
      }
      return undefined;
    };
    const explicitDescription = fieldValue('descriptionField');
    const issue = fieldIssue('idField', idField, false)
      ?? fieldIssue('labelField', labelField, true)
      ?? (explicitDescription ? fieldIssue('descriptionField', explicitDescription, true) : undefined);
    if (issue) {
      invalid(issue);
      continue;
    }
    const descriptionField = explicitDescription
      || SEARCH_DESCRIPTION_FIELDS.find((name) => name !== labelField && isTextField(items, name));
    const limitParam = explicitLimit || SEARCH_LIMIT_PARAMS.find((name) => query.has(name));
    const search: ChatEntitySearchData = {
      tool: tool.definitionId,
      path: tool.path,
      queryParam,
      itemsPath: [...itemsPath],
      idField,
      labelField,
      ...(descriptionField ? { descriptionField } : {}),
      ...(limitParam ? { limitParam } : {}),
    };
    const carried = carriedIssues({
      type,
      label: raw.label ?? type,
      ...(raw.aliases !== undefined ? { aliases: raw.aliases } : {}),
      search,
    });
    if (carried) {
      invalid(`cannot be carried by the chat: ${carried}`);
      continue;
    }
    if (!declaration) {
      findings.push(toolFinding('mention-source-undeclared-type', 'warning', subject,
        `${at} names ${tool.definitionId}, which does not declare the entity type ${type} by identity (outputEntities); the source is used with the fields given here.`));
    }
    result.push({
      type,
      tool,
      search,
      ...(raw.label !== undefined ? { label: raw.label as ChatText } : {}),
      ...(raw.aliases !== undefined ? { aliases: raw.aliases as ChatEntityAliases } : {}),
    });
  }
  return { sources: result, findings };
}

/** The protocol's issues with one entity, its paths relative to the entry (`label.pl`, `aliases.de[0]`); undefined when it is carried. */
function carriedIssues(entity: Record<string, unknown>): string | undefined {
  try {
    parseChatInteractions({ schemaVersion: 1, entities: [entity], commands: [] });
    return undefined;
  } catch (error) {
    if (!(error instanceof ChatInteractionsError)) throw error;
    return error.issues.slice(0, 3).map((issue) => issue.replace(/^\$\.entities\[0\]\.?/, '')).join('; ');
  }
}
