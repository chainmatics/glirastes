import {
  CHAT_ENTITY_TYPE_PATTERN,
  CHAT_INTERACTION_LIMITS,
  parseChatInteractions,
  type ChatCommandData,
  type ChatEntityActionData,
  type ChatEntityData,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatText,
} from '../../contracts/chat-interactions.js';
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits } from './canonical.js';
import { actionLabel, commandLabel, humanizeIdentifier, singular, type Label } from './chat-labels.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry, ToolTitle } from './types.js';

export { humanizeIdentifier } from './chat-labels.js';

export interface DeriveChatInteractionsInput {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}

interface BoundTool {
  definitionId: string;
  method?: string;
  path?: string;
  contract: ToolContract;
  title?: ToolTitle;
  riskClass: string;
  noun?: { language: 'de' | 'en'; text: string };
}

/** Client actions of the chat itself; offering them inside the chat is noise. An override adds one back. */
export const CHAT_INTERNAL_ACTION = /^(?:ai-?chat|chat|assistant|command-?palette|command-?menu|cmdk)(?:[.\-_]|$)/i;

/** Query parameters that make a read endpoint an entity search, best first. */
const SEARCH_PARAMS = ['search', 'q', 'query', 'term'];
const LIMIT_PARAMS = ['limit', 'pageSize'];
const LABEL_FIELDS = ['title', 'name', 'displayName', 'label', 'subject', 'email'];
const DESCRIPTION_FIELDS = ['description', 'email', 'status', 'subtitle', 'summary'];
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const CONTROL = /[\u0000-\u001F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number = CHAT_INTERACTION_LIMITS.labelLength): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A text the list can show, clamped; `undefined` falls back to the derived label instead of dropping the entry. */
function safe(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && !CONTROL.test(trimmed) ? clamp(trimmed) : undefined;
}

function safeTitle(title: ToolTitle | undefined): ToolTitle | undefined {
  const en = safe(title?.en);
  const de = safe(title?.de);
  return en || de ? { ...(en ? { en } : {}), ...(de ? { de } : {}) } : undefined;
}

function clampLabel(label: Label): Label {
  return { en: clamp(label.en), de: clamp(label.de) };
}

function nounOf(entity: ChatEntityData, language: 'de' | 'en'): string | undefined {
  return typeof entity.label === 'string' ? entity.label : entity.label[language];
}

/** Inside the entity's own menu a leading noun repeats the entity ("Aufgabe endgültig löschen" → "Endgültig löschen"). */
function withoutNoun(text: string, noun: string | undefined): string {
  if (!noun) return text;
  const prefix = `${noun} `;
  if (text.length <= prefix.length || text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return text;
  const rest = text.slice(prefix.length).trimStart();
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : text;
}

function entityType(segment: string): string | undefined {
  const type = singular(segment).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return CHAT_ENTITY_TYPE_PATTERN.test(type) ? type : undefined;
}

function idSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function staticSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment && !segment.startsWith(':'));
}

function properties(schema: JsonSchemaLike | undefined): Record<string, JsonSchemaLike> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties as Record<string, JsonSchemaLike> : {};
}

function requiredKeys(schema: JsonSchemaLike | undefined): Set<string> {
  return new Set(isRecord(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : []);
}

function stringOptions(schema: JsonSchemaLike | undefined): string[] | undefined {
  if (!isRecord(schema) || !Array.isArray(schema.enum)) return undefined;
  if (!schema.enum.every((value) => typeof value === 'string')) return undefined;
  // A blank choice is the empty field; a choice the list cannot show drops the closed set.
  const values = (schema.enum as string[]).filter((value) => value.trim().length > 0);
  return values.length > 0 && values.every((value) => value.length <= 100 && !CONTROL.test(value))
    ? values.slice(0, CHAT_INTERACTION_LIMITS.options)
    : undefined;
}

/**
 * A value the argument form can type: a string or a string enum. An array
 * (`array: 'comma' | 'repeat'` filter keys) is not typed: the form sends one
 * scalar and the bound input schema (`{ type: 'array' }`) rejects a scalar.
 */
function isStringInput(schema: JsonSchemaLike | undefined): boolean {
  if (!isRecord(schema)) return false;
  if (stringOptions(schema)) return true;
  return schema.type === 'string';
}

function argFor(
  name: string,
  schema: JsonSchemaLike | undefined,
  required: boolean,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg {
  const options = stringOptions(schema);
  const entity = options ? undefined : entityOf(name);
  const last = name.split('.').at(-1)!;
  return {
    name,
    label: clamp(humanizeIdentifier(last) || last),
    ...(required ? { required: true } : {}),
    ...(entity ? { entity } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * Arguments the user fills in for a tool, or `undefined` when a required
 * value cannot be typed in the chat (objects, numbers, booleans).
 */
function argsFor(
  input: JsonSchemaLike,
  skip: ReadonlySet<string>,
  entityOf: (name: string) => string | undefined,
): ChatInteractionArg[] | undefined {
  const required = requiredKeys(input);
  const result: ChatInteractionArg[] = [];
  for (const [name, schema] of Object.entries(properties(input)).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (skip.has(name)) continue;
    if (name === 'params' && isRecord(schema)) {
      const nestedRequired = requiredKeys(schema);
      for (const [param, paramSchema] of Object.entries(properties(schema)).sort(([left], [right]) => compareCodeUnits(left, right))) {
        if (!isStringInput(paramSchema)) return undefined;
        result.push(argFor(`params.${param}`, paramSchema, required.has('params') || nestedRequired.has(param), entityOf));
      }
      continue;
    }
    if (!FIELD.test(name)) {
      if (required.has(name)) return undefined;
      continue;
    }
    if (!isStringInput(schema)) {
      if (required.has(name)) return undefined;
      continue;
    }
    result.push(argFor(name, schema, required.has(name), entityOf));
  }
  return result.length > CHAT_INTERACTION_LIMITS.args ? undefined : result;
}

function navigationTitle(path: string): { en: string; de: string } {
  const segments = staticSegments(path);
  if (segments.length === 0) return { en: 'Home', de: 'Startseite' };
  const title = humanizeIdentifier(segments.join(' '));
  return { en: title, de: title };
}

/**
 * True when the entries pass the strict check on their own: an identifier
 * the protocol cannot carry drops its entry, never the whole refresh.
 */
function carries(entities: ReadonlyArray<ChatEntityData>, commands: ReadonlyArray<ChatCommandData>): boolean {
  try {
    parseChatInteractions({ schemaVersion: 1, entities, commands });
    return true;
  } catch {
    return false;
  }
}

interface SearchCandidate {
  type: string;
  entity: ChatEntityData;
  /** Path whose item endpoints become actions (`/api/users` for `/api/users/search`). */
  collection: string;
}

/** A read endpoint with a search parameter whose output is a list of objects with an id and a label. */
function searchEntity(tool: BoundTool): SearchCandidate | undefined {
  if ((tool.method !== 'GET' && tool.method !== 'HEAD') || !tool.path || tool.path.includes(':')) return undefined;
  const query = new Set(tool.contract.params.query);
  const segments = staticSegments(tool.path);
  const isSearchPath = segments.at(-1) === 'search';
  if (isSearchPath && segments.length < 2) return undefined;
  const queryParam = (isSearchPath ? [...SEARCH_PARAMS, 'name'] : SEARCH_PARAMS).find((name) => query.has(name));
  if (!queryParam) return undefined;
  const listName = segments.at(isSearchPath ? -2 : -1) ?? '';
  const type = entityType(listName);
  if (!type) return undefined;
  const output = tool.contract.output;
  let itemsPath: string[] | undefined;
  let items: JsonSchemaLike | undefined;
  if (isRecord(output) && output.type === 'array') {
    itemsPath = [];
    items = output.items as JsonSchemaLike | undefined;
  } else {
    const lists = Object.entries(properties(output))
      .filter(([name, schema]) => FIELD.test(name) && isRecord(schema) && schema.type === 'array' && isRecord(schema.items));
    const preferred = lists.find(([name]) => name === listName) ?? (lists.length === 1 ? lists[0] : undefined);
    if (preferred) {
      itemsPath = [preferred[0]];
      items = (preferred[1] as Record<string, unknown>).items as JsonSchemaLike;
    }
  }
  const fields = properties(items);
  const isText = (name: string) => isRecord(fields[name]) && (fields[name] as Record<string, unknown>).type === 'string';
  const idField = ['id', 'uuid', `${type}Id`].find((name) => isRecord(fields[name]));
  const labelField = LABEL_FIELDS.find((name) => name !== idField && isText(name));
  if (!itemsPath || !idField || !labelField) return undefined;
  const descriptionField = DESCRIPTION_FIELDS.find((name) => name !== labelField && isText(name));
  const limitParam = LIMIT_PARAMS.find((name) => query.has(name));
  const label = clamp(humanizeIdentifier(type));
  const noun = tool.noun;
  const entity: ChatEntityData = {
    type,
    label: { en: noun?.language === 'en' ? noun.text : label, de: noun?.language === 'de' ? noun.text : label },
    search: {
      tool: tool.definitionId,
      path: tool.path,
      queryParam,
      itemsPath,
      idField,
      labelField,
      ...(descriptionField ? { descriptionField } : {}),
      ...(limitParam ? { limitParam } : {}),
    },
  };
  const collection = isSearchPath ? tool.path.replace(/\/search\/?$/, '') : tool.path;
  return carries([entity], []) ? { type, entity, collection } : undefined;
}

/**
 * Derives the chat's `@` entities and `/` commands from the enabled tools,
 * a pure function of the setup artifact and the tool contracts:
 *
 * - entities from read endpoints with a search parameter (`search`, `q`,
 *   `query`, `term`) whose output lists objects with an id and a label;
 * - entity actions from endpoints with exactly one path parameter below the
 *   entity's collection (`PATCH /api/tasks/:id`), and "Open" from pages with
 *   one parameter of the entity (`/tasks/:taskId`);
 * - commands from navigation (one per page without parameters), URL
 *   filters and client actions.
 *
 * Labels come from the tool's reviewed title and the presentation noun where
 * the app has them, else from identifiers; overrides replace them. Bounded and sorted, so the module stays byte-stable;
 * an entry the protocol cannot carry is dropped alone, so app code never
 * makes the generated module (and `tools refresh`) fail here.
 */
export function deriveChatInteractions(input: DeriveChatInteractionsInput): ChatInteractionsData {
  const contracts = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools: BoundTool[] = input.artifact.tools
    .filter((tool) => tool.enabled)
    .flatMap((tool): BoundTool[] => {
      const entry = contracts.get(tool.toolId);
      if (!entry?.contract) return [];
      const title = safeTitle(entry.title);
      const presentation = tool.presentation;
      // The templated fallback repeats the tool label in all three texts; only a reviewed one names the thing.
      const reviewed = presentation && !(presentation.singular === presentation.plural && presentation.plural === presentation.approval);
      const locale = reviewed ? presentation.locale.toLowerCase() : undefined;
      const language = locale?.startsWith('de') ? 'de' : locale?.startsWith('en') ? 'en' : undefined;
      const noun = language ? safe(presentation?.singular) : undefined;
      return [{
        definitionId: tool.name, method: tool.method, path: tool.path, contract: entry.contract, riskClass: tool.riskClass,
        ...(title ? { title } : {}),
        ...(language && noun ? { noun: { language, text: noun } } : {}),
      }];
    })
    .sort((left, right) => compareCodeUnits(left.definitionId, right.definitionId));

  const searches = new Map<string, SearchCandidate>();
  for (const candidate of tools
    .map(searchEntity)
    .filter((entry): entry is SearchCandidate => entry !== undefined)
    .sort((left, right) => compareCodeUnits(left.entity.search!.path, right.entity.search!.path))) {
    if (!searches.has(candidate.type)) searches.set(candidate.type, candidate);
  }
  const entityOf = (name: string): string | undefined => {
    const match = /^(?:params\.)?([A-Za-z][A-Za-z0-9]*?)(?:Id|_id)$/.exec(name);
    const type = match ? entityType(match[1]!) : undefined;
    return type && searches.has(type) ? type : undefined;
  };

  const actions = new Map<string, ChatEntityActionData[]>();
  const destructive = new Set<string>();
  const addAction = (type: string, action: ChatEntityActionData, isDestructive = false) => {
    if (!carries([{ type, label: type, actions: [action] }], [])) return;
    const list = actions.get(type) ?? [];
    if (!list.some((entry) => entry.id === action.id)) list.push(action);
    if (isDestructive) destructive.add(action.id);
    actions.set(type, list);
  };
  for (const { type, entity, collection } of searches.values()) {
    for (const tool of tools) {
      if (!tool.path || tool.contract.uiAction) continue;
      const match = new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/:([A-Za-z_][A-Za-z0-9_]*)(?:/([A-Za-z0-9_-]+))?$`)
        .exec(tool.path);
      if (!match || tool.contract.params.path.length !== 1) continue;
      const entityArg = match[1]!;
      const args = argsFor(tool.contract.input, new Set([entityArg]), entityOf);
      if (!args) continue;
      const label = clampLabel(actionLabel({
        definitionId: tool.definitionId, method: tool.method, trailingSegment: match[2], title: tool.title,
      }));
      addAction(type, {
        id: `${type}.${tool.definitionId}`,
        label: { en: withoutNoun(label.en, nounOf(entity, 'en')), de: withoutNoun(label.de, nounOf(entity, 'de')) },
        entityArg,
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'tool', tool: tool.definitionId },
      }, tool.riskClass === 'delete' || tool.method === 'DELETE');
    }
  }

  const commands: ChatCommandData[] = [];
  const commandIds = new Set<string>();
  const addCommand = (command: ChatCommandData) => {
    if (commandIds.has(command.id) || !carries([], [command])) return;
    commandIds.add(command.id);
    commands.push(command);
  };
  for (const tool of tools) {
    const action = tool.contract.uiAction;
    if (!action) continue;
    if (action.kind === 'navigate') {
      const destination = properties(tool.contract.input).destination;
      const paths = isRecord(destination) && Array.isArray(destination.enum)
        ? destination.enum.filter((value): value is string => typeof value === 'string')
        : [];
      for (const path of paths) {
        const params = path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
        if (params.length === 0) {
          const title = navigationTitle(path);
          const segments = staticSegments(path);
          addCommand({
            id: `open.${segments.length > 0 ? segments.map(idSegment).join('.') : 'home'}`,
            label: { en: clamp(`Open ${title.en}`), de: clamp(`${title.de} öffnen`) },
            ...(segments.length > 0 ? { keywords: segments.slice(0, CHAT_INTERACTION_LIMITS.keywords).map((segment) => clamp(segment, 60)) } : {}),
            run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
          });
          continue;
        }
        if (params.length !== 1) continue;
        const segments = path.split('/');
        const index = segments.indexOf(`:${params[0]}`);
        const type = entityOf(params[0]!) ?? (params[0] === 'id' && index > 0 ? entityType(segments[index - 1]!) : undefined);
        if (!type || !searches.has(type)) continue;
        addAction(type, {
          id: `${type}.open`,
          label: { en: 'Open', de: 'Öffnen' },
          entityArg: `params.${params[0]}`,
          run: { kind: 'ui', tool: tool.definitionId, args: { destination: path } },
        });
      }
      continue;
    }
    if (action.kind === 'client-action' && CHAT_INTERNAL_ACTION.test(action.actionId)) continue;
    const args = argsFor(tool.contract.input, new Set(), entityOf);
    if (!args) continue;
    if (action.kind === 'filter') {
      const view = tool.definitionId.replace(/^ui\.filter\./, '');
      const title = humanizeIdentifier(view);
      addCommand({
        id: `filter.${idSegment(view)}`,
        label: { en: tool.title?.en ?? clamp(`Filter ${title}`), de: tool.title?.de ?? clamp(`${title} filtern`) },
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'ui', tool: tool.definitionId },
      });
      continue;
    }
    const id = tool.definitionId.replace(/^ui\./, '');
    addCommand({
      id,
      label: clampLabel(commandLabel(id, tool.title)),
      ...(args.length > 0 ? { args } : {}),
      run: { kind: 'ui', tool: tool.definitionId },
    });
  }

  const entities = [...searches.values()]
    .map(({ type, entity }) => {
      const list = (actions.get(type) ?? [])
        .sort((left, right) => (Number(destructive.has(left.id)) - Number(destructive.has(right.id)))
          || compareCodeUnits(left.id, right.id))
        .slice(0, CHAT_INTERACTION_LIMITS.actionsPerEntity);
      return list.length > 0 ? { ...entity, actions: list } : entity;
    })
    .sort((left, right) => compareCodeUnits(left.type, right.type))
    .slice(0, CHAT_INTERACTION_LIMITS.entities);
  return parseChatInteractions({
    schemaVersion: 1,
    entities,
    commands: commands
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .slice(0, CHAT_INTERACTION_LIMITS.commands),
  });
}
