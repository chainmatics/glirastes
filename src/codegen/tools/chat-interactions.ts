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
import type { JsonSchemaLike, ToolContract, ToolContractsEntry } from './types.js';

export interface DeriveChatInteractionsInput {
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}

interface BoundTool {
  definitionId: string;
  method?: string;
  path?: string;
  contract: ToolContract;
}

/** Query parameters that make a read endpoint an entity search, best first. */
const SEARCH_PARAMS = ['search', 'q', 'query', 'term'];
const LIMIT_PARAMS = ['limit', 'pageSize'];
const LABEL_FIELDS = ['title', 'name', 'displayName', 'label', 'subject', 'email'];
const DESCRIPTION_FIELDS = ['description', 'email', 'status', 'subtitle', 'summary'];
const FIELD = /^[A-Za-z_][\w-]{0,63}$/;
const CONTROL = /[\u0000-\u001F]/;
const VERBS: Record<string, { en: string; de: string }> = {
  get: { en: 'Show', de: 'Anzeigen' },
  check: { en: 'Check', de: 'Prüfen' },
  update: { en: 'Edit', de: 'Bearbeiten' },
  delete: { en: 'Delete', de: 'Löschen' },
  complete: { en: 'Complete', de: 'Erledigen' },
  archive: { en: 'Archive', de: 'Archivieren' },
  assign: { en: 'Assign', de: 'Zuweisen' },
  close: { en: 'Close', de: 'Schließen' },
  reopen: { en: 'Reopen', de: 'Wieder öffnen' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number = CHAT_INTERACTION_LIMITS.labelLength): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `my-tasks`, `myTasks`, `my_tasks` → `My tasks`. */
export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : '';
}

const IRREGULAR: Record<string, string> = { people: 'person', children: 'child', men: 'man', women: 'woman' };

/** `tasks` → `task`, `categories` → `category`, `people` → `person`. */
function singular(segment: string): string {
  const irregular = IRREGULAR[segment.toLowerCase()];
  if (irregular) return irregular;
  if (/ies$/i.test(segment)) return `${segment.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/i.test(segment)) return segment;
  if (/(?:sses|xes|ches|shes)$/i.test(segment)) return segment.slice(0, -2);
  if (/s$/i.test(segment)) return segment.slice(0, -1);
  return segment;
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
  const candidate = isRecord(schema) && schema.type === 'array' && isRecord(schema.items) ? schema.items : schema;
  if (!isRecord(candidate) || !Array.isArray(candidate.enum)) return undefined;
  if (!candidate.enum.every((value) => typeof value === 'string')) return undefined;
  // A blank choice is the empty field; a choice the list cannot show drops the closed set.
  const values = (candidate.enum as string[]).filter((value) => value.trim().length > 0);
  return values.length > 0 && values.every((value) => value.length <= 100 && !CONTROL.test(value))
    ? values.slice(0, CHAT_INTERACTION_LIMITS.options)
    : undefined;
}

/** A value the argument form can type: a string, a string enum, or an array of string enums. */
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
      for (const [param, paramSchema] of Object.entries(properties(schema))) {
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

/** The trailing path segment (`/:id/pin` → `pin`), else the verb of the definition id (`tasks.update` → `update`). */
function verbLabel(definitionId: string, trailingSegment: string | undefined): ChatText {
  const verb = trailingSegment ?? definitionId.split('.').at(-1)!;
  const known = VERBS[verb];
  if (known) return known;
  const text = clamp(humanizeIdentifier(verb) || verb);
  return { en: text, de: text };
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
}

/** A read endpoint with a search parameter whose output is a list of objects with an id and a label. */
function searchEntity(tool: BoundTool): SearchCandidate | undefined {
  if ((tool.method !== 'GET' && tool.method !== 'HEAD') || !tool.path || tool.path.includes(':')) return undefined;
  const query = new Set(tool.contract.params.query);
  const queryParam = SEARCH_PARAMS.find((name) => query.has(name));
  if (!queryParam) return undefined;
  const segments = staticSegments(tool.path);
  const type = entityType(segments.at(-1) ?? '');
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
    const preferred = lists.find(([name]) => name === segments.at(-1)) ?? (lists.length === 1 ? lists[0] : undefined);
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
  const entity: ChatEntityData = {
    type,
    label: { en: label, de: label },
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
  return carries([entity], []) ? { type, entity } : undefined;
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
 * Labels are English and German defaults from identifiers; overrides and
 * skills replace them. Bounded and sorted, so the module stays byte-stable;
 * an entry the protocol cannot carry is dropped alone, so app code never
 * makes the generated module (and `tools refresh`) fail here.
 */
export function deriveChatInteractions(input: DeriveChatInteractionsInput): ChatInteractionsData {
  const contracts = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools: BoundTool[] = input.artifact.tools
    .filter((tool) => tool.enabled)
    .flatMap((tool) => {
      const contract = contracts.get(tool.toolId)?.contract;
      return contract ? [{ definitionId: tool.name, method: tool.method, path: tool.path, contract }] : [];
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
  const addAction = (type: string, action: ChatEntityActionData) => {
    if (!carries([{ type, label: type, actions: [action] }], [])) return;
    const list = actions.get(type) ?? [];
    if (!list.some((entry) => entry.id === action.id)) list.push(action);
    actions.set(type, list);
  };
  for (const { type, entity } of searches.values()) {
    const collection = entity.search!.path;
    for (const tool of tools) {
      if (!tool.path || tool.contract.uiAction) continue;
      const match = new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/:([A-Za-z_][A-Za-z0-9_]*)(?:/([A-Za-z0-9_-]+))?$`)
        .exec(tool.path);
      if (!match || tool.contract.params.path.length !== 1) continue;
      const entityArg = match[1]!;
      const args = argsFor(tool.contract.input, new Set([entityArg]), entityOf);
      if (!args) continue;
      addAction(type, {
        id: `${type}.${tool.definitionId}`,
        label: verbLabel(tool.definitionId, match[2]),
        entityArg,
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'tool', tool: tool.definitionId },
      });
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
    const args = argsFor(tool.contract.input, new Set(), entityOf);
    if (!args) continue;
    if (action.kind === 'filter') {
      const view = tool.definitionId.replace(/^ui\.filter\./, '');
      const title = humanizeIdentifier(view);
      addCommand({
        id: `filter.${idSegment(view)}`,
        label: { en: clamp(`Filter ${title}`), de: clamp(`${title} filtern`) },
        ...(args.length > 0 ? { args } : {}),
        run: { kind: 'ui', tool: tool.definitionId },
      });
      continue;
    }
    const id = tool.definitionId.replace(/^ui\./, '');
    const label = clamp(humanizeIdentifier(id));
    addCommand({
      id,
      label: { en: label, de: label },
      ...(args.length > 0 ? { args } : {}),
      run: { kind: 'ui', tool: tool.definitionId },
    });
  }

  const entities = [...searches.values()]
    .map(({ type, entity }) => {
      const list = (actions.get(type) ?? [])
        .sort((left, right) => compareCodeUnits(left.id, right.id))
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
