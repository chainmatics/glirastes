import {
  formatChatCommandMessage,
  serializeChatCommandArgs,
} from '../../contracts/chat-command.js';
import {
  CHAT_ENTITY_ALIAS_PATTERN,
  chatText,
  isChatArgumentPath,
  type ChatEntityAliases,
  type ChatEntitySearchData,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatLocaleCode,
} from '../../contracts/chat-interactions.js';
import { pickLanguage } from '../../contracts/localized-text.js';
import { resolveCompletionLimits, type CompletionLimits } from '../completions/completion-search.js';
import type {
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  MentionData,
} from '../types.js';
import { fillTemplate } from '../utils/fill-template.js';
import { foldText } from '../utils/fold-text.js';
import { normalizeMentionSlug } from '../utils/mention-markup.js';
import {
  entitiesFromData,
  toChatEntityItem,
  type ChatCommandDefinition,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type DerivedEntityOptions,
} from './definitions.js';

/**
 * What the page the user is on says about `@` references. Set by the host
 * (`mentionContext` on the provider, `useMentionContext` in a page); a later
 * view context feeds the same value. Unknown or unsearchable types are ignored.
 */
export interface ChatMentionContext {
  /** Entity types whose `@` hits come first, in this order; the other types follow in their declared order. */
  readonly preferredTypes?: ReadonlyArray<string>;
  /** Typing a bare `@` starts as `@<name>:`, searching only this type (Backspace right behind it removes it). */
  readonly presetType?: string;
}

/**
 * Texts of the `@`/`/` lists. Each falls back to the built-in text of the
 * registry's `locale` (English, German for `de`). The provider passes the
 * app's own `ChatLocale` texts here.
 */
export interface ChatInteractionTexts {
  /** Heading of the `/` commands. Built in: `Commands`, German `Befehle`. */
  readonly commandsGroup?: string;
  /** Heading of the `@<type>:` suggestions. Built in: `Filter by type`, German `Nach Typ filtern`. */
  readonly entityTypesGroup?: string;
  /** Description of one `@<type>:` suggestion; `{type}` is the type's label. Built in: `Search only this type`. */
  readonly entityTypeFilter?: string;
}

const BUILT_IN_TEXTS: Readonly<Record<'en' | 'de', Required<ChatInteractionTexts>>> = {
  en: { commandsGroup: 'Commands', entityTypesGroup: 'Filter by type', entityTypeFilter: 'Search only this type' },
  de: { commandsGroup: 'Befehle', entityTypesGroup: 'Nach Typ filtern', entityTypeFilter: 'Nur diesen Typ durchsuchen' },
};

/** Every built-in text of the chat interactions, per key (to tell an app's own text from a default). */
export const BUILT_IN_CHAT_INTERACTION_TEXTS: Readonly<Record<keyof ChatInteractionTexts, ReadonlySet<string>>> = {
  commandsGroup: new Set(Object.values(BUILT_IN_TEXTS).map((texts) => texts.commandsGroup)),
  entityTypesGroup: new Set(Object.values(BUILT_IN_TEXTS).map((texts) => texts.entityTypesGroup)),
  entityTypeFilter: new Set(Object.values(BUILT_IN_TEXTS).map((texts) => texts.entityTypeFilter)),
};

/** Item `type` of an `@<type>:` suggestion: never a mention, its pick (`select: 'query'`) only rewrites the query. */
export const ENTITY_TYPE_FILTER_ITEM_TYPE = 'mention-filter';

/** At most this many `@<type>:` suggestions above the hits. */
const MAX_TYPE_SUGGESTIONS = 3;

export interface ChatInteractionsConfig extends DerivedEntityOptions {
  /** Derived interactions: `useChatInteractionsData(endpoint)` or the generated module's `chatInteractions`. */
  readonly data?: ChatInteractionsData;
  /** App-defined entities; one with the type of a derived entity replaces it. */
  readonly entities?: ReadonlyArray<ChatEntityDefinition>;
  /** App-defined commands; one with the id of a derived command replaces it. */
  readonly commands?: ReadonlyArray<ChatCommandDefinition>;
  /** Language of labels and default texts. Default `en`. */
  readonly locale?: ChatLocaleCode;
  /** Passed to entity searches; set by the provider from `completionContext`. */
  readonly context?: CompletionPermissionContext;
  /**
   * Order and preset of the `@` list. A function is read at every search, so
   * a changing context needs no new registry. The provider sets it from its
   * `mentionContext` prop and `useMentionContext`.
   */
  readonly mentionContext?: ChatMentionContext | (() => ChatMentionContext | null | undefined);
  /** List headings and descriptions; built-in texts of `locale` otherwise. */
  readonly texts?: ChatInteractionTexts;
  /**
   * List size per trigger character, e.g. `{ '/': { perProvider: 30, total: 30 } }`.
   * Default 8 per provider and 12 in total, as before; at most 100 and 200.
   * The provider applies it to every provider of that trigger, the app's own
   * `completionProviders` included; `@`'s `perProvider` also sizes the
   * entity search of an argument field.
   */
  readonly completionLimits?: Readonly<Record<string, CompletionLimits>>;
}

/** A command or entity action that still needs arguments from the user. */
export interface PendingChatCommand {
  readonly commandId: string;
  readonly tool: string;
  /** The visible name, e.g. `Assign` or `Filter Tasks`. */
  readonly label: string;
  readonly fixedArgs: Readonly<Record<string, unknown>>;
  /** Arguments the form asks for. */
  readonly args: ReadonlyArray<ChatInteractionArg>;
  /** Values already known (entity ids, picked mentions), by argument name. */
  readonly values: Readonly<Record<string, string>>;
  /** Display labels for entity values, by argument name. */
  readonly valueLabels: Readonly<Record<string, string>>;
  /** Set when the last attempt was refused, e.g. values too long. */
  readonly error?: 'invalid';
}

export type ChatSendPlan =
  /** A direct command message, ready for the transport. */
  | { readonly status: 'send'; readonly text: string }
  /** A prompt command: the text the model receives instead of the command token. */
  | { readonly status: 'prompt'; readonly text: string }
  /** The command needs arguments first; show `PendingChatCommand` as a form. */
  | { readonly status: 'needs-args'; readonly request: PendingChatCommand };

export interface ChatInteractionRegistry {
  readonly locale: ChatLocaleCode;
  /** `/` commands, `@<type>:` suggestions and `@` entities for `createCompletionSearch`. */
  readonly providers: ReadonlyArray<ChatCompletionProvider>;
  command(id: string): ChatCommandDefinition | undefined;
  entity(type: string): ChatEntityDefinition | undefined;
  /** The derived search of each entity type: which tool lists it and where id and label sit in its result. */
  readonly entitySearches: ReadonlyArray<{ readonly type: string; readonly search: ChatEntitySearchData }>;
  /** Searches one entity type, e.g. for an argument field; failures yield no hits. */
  searchEntity(type: string, query: string, signal: AbortSignal): Promise<ChatEntityItem[]>;
  /**
   * The `@<name>:<text>` filter of a query typed after `@`: the entity type
   * and the text searched in it; undefined when the text before the first
   * colon is no filter name (then the whole query searches every type).
   */
  entityFilter(query: string): { readonly type: string; readonly text: string } | undefined;
  /**
   * The names that select an entity type in `@<name>:` for the registry's
   * language, the primary (shown) one first; empty for an unknown or
   * unsearchable type.
   */
  entityFilterNames(type: string): ReadonlyArray<string>;
  /**
   * Groups of entity types (sorted) that share a label or alias in the
   * registry's language: that name selects none of them. Logged as a count
   * when a registry with this set of conflicts is first created on the page.
   */
  readonly entityFilterConflicts: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * The query a bare `trigger` starts with (`RichMentionInput`'s
   * `completionPreset`): `<name>:` for `@` while the mention context names a
   * `presetType`; undefined otherwise.
   */
  completionPreset(trigger: string): string | undefined;
  /**
   * How to send a composed message: `undefined` for a normal model message
   * (no command, several commands, or a command mixed with free text).
   */
  planMessage(text: string, mentions: ReadonlyArray<MentionData>): ChatSendPlan | undefined;
  /** An entity action picked from the `@` list. */
  planAction(entity: { type: string; id: string; label: string }, actionId: string): ChatSendPlan | undefined;
  /** Sends a pending command with the values (and entity labels) from its form, or asks again. */
  completeCommand(
    pending: PendingChatCommand,
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ): ChatSendPlan;
}

const fold = foldText;

/** German spelling without umlauts: `Übersicht` → `uebersicht`, `Schließen` → `schliessen`. */
function transliterate(value: string): string {
  return fold(value.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));
}

/** The forms a filter name is compared in: folded, and with the German transliteration. */
function nameKeys(value: string): string[] {
  const keys = new Set([fold(value), transliterate(value)]);
  keys.delete('');
  return [...keys];
}

/**
 * A label or alias usable as a filter name: no whitespace, no colon, no
 * control character, and something left once folded (not only combining marks).
 */
function isFilterName(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ENTITY_ALIAS_PATTERN.test(value) && fold(value) !== '';
}

/** Conflict sets already logged on this page: a rebuilt registry (new `completionContext`) logs a set once. */
const loggedFilterConflicts = new Set<string>();

/** The aliases of `locale`: a plain list serves every language, a per-language list falls back like `chatText`. */
function aliasesFor(aliases: ChatEntityAliases | undefined, locale: string): ReadonlyArray<unknown> {
  if (!aliases || typeof aliases !== 'object') return [];
  if (Array.isArray(aliases)) return aliases as ReadonlyArray<unknown>;
  const perLanguage = aliases as Readonly<Record<string, unknown>>;
  const language = pickLanguage(Object.keys(perLanguage).filter((key) => Array.isArray(perLanguage[key])), locale);
  return language === undefined ? [] : perLanguage[language] as ReadonlyArray<unknown>;
}

function rankWith(normalize: (value: string) => string, label: string, command: ChatCommandDefinition, needle: string): number | undefined {
  const folded = normalize(label);
  if (folded.startsWith(needle)) return 0;
  if (folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 1;
  if (folded.includes(needle) || normalize(normalizeMentionSlug(label)).includes(needle)) return 2;
  if (normalize(command.id).includes(needle)) return 3;
  if ((command.keywords ?? []).some((keyword) => normalize(keyword).includes(needle))) return 4;
  return undefined;
}

function rank(label: string, command: ChatCommandDefinition, query: string): number | undefined {
  const needle = fold(query);
  if (!needle) return 0;
  // `ueber` and `uber` both find `Übersicht`, `schliessen` finds `Schließen`.
  const ranks = [rankWith(fold, label, command, needle), rankWith(transliterate, label, command, transliterate(query))]
    .filter((value): value is number => value !== undefined);
  return ranks.length > 0 ? Math.min(...ranks) : undefined;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function valueAt(source: Record<string, unknown>, path: string): unknown {
  if (path in source) return source[path];
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function tokenOf(mention: MentionData): string | undefined {
  return typeof mention.prefix === 'string' && typeof mention.slug === 'string'
    ? `${mention.prefix}${mention.slug}`
    : undefined;
}

function withoutToken(text: string, token: string): { text: string; found: boolean } {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`);
  return pattern.test(text) ? { text: text.replace(pattern, '$1'), found: true } : { text, found: false };
}

/**
 * Turns declarative entities and commands into completion providers and
 * send plans. App definitions replace derived ones of the same id or type.
 */
export function createChatInteractionRegistry(config: ChatInteractionsConfig): ChatInteractionRegistry {
  const locale = config.locale ?? 'en';
  const entities = new Map<string, ChatEntityDefinition>();
  for (const entity of config.data ? entitiesFromData(config.data, config) : []) entities.set(entity.type, entity);
  for (const entity of config.entities ?? []) entities.set(entity.type, entity);
  const commands = new Map<string, ChatCommandDefinition>();
  for (const command of config.data?.commands ?? []) commands.set(command.id, command);
  for (const command of config.commands ?? []) commands.set(command.id, command);

  // An argument field searches one type: `@`'s per-provider cap when set, else 8 as before.
  const argumentLimit = resolveCompletionLimits({ limits: config.completionLimits }, '@').perProvider;

  const builtInTexts = BUILT_IN_TEXTS[/^de(?:-|$)/i.test(locale) ? 'de' : 'en'];
  const text = (key: keyof ChatInteractionTexts): string => {
    const own = config.texts?.[key];
    return typeof own === 'string' && own.trim() ? own : builtInTexts[key];
  };

  // Types the `@` filter can select: app entities, and derived ones with a search.
  const searchable = new Set<string>();
  for (const entity of config.data?.entities ?? []) if (entity.search) searchable.add(entity.type);
  for (const entity of config.entities ?? []) searchable.add(entity.type);
  const searchableTypes = [...entities.keys()].filter((type) => searchable.has(type));

  // Filter names per type (label, aliases, canonical type). A label or alias another type also
  // claims selects neither; the canonical type always selects its own type.
  const candidates: Array<{ type: string; name: string; canonical: boolean }> = [];
  for (const type of searchableTypes) {
    const entity = entities.get(type)!;
    const label = chatText(entity.label, locale);
    if (isFilterName(label)) candidates.push({ type, name: label, canonical: false });
    for (const alias of aliasesFor(entity.aliases, locale)) {
      if (isFilterName(alias)) candidates.push({ type, name: alias, canonical: false });
    }
    candidates.push({ type, name: type, canonical: true });
  }
  const owners = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    for (const key of nameKeys(candidate.name)) {
      const set = owners.get(key) ?? new Set<string>();
      set.add(candidate.type);
      owners.set(key, set);
    }
  }
  const filterNames = new Map<string, string[]>();
  const filterLookup = new Map<string, string>();
  const shared = new Set<string>();
  for (const candidate of candidates) {
    const keys = nameKeys(candidate.name);
    const others = new Set(keys.flatMap((key) => [...owners.get(key)!].filter((type) => type !== candidate.type)));
    if (others.size > 0 && !candidate.canonical) {
      shared.add([candidate.type, ...others].sort().join('/'));
      continue;
    }
    const list = filterNames.get(candidate.type) ?? [];
    if (!list.some((name) => fold(name) === fold(candidate.name))) list.push(candidate.name);
    filterNames.set(candidate.type, list);
    for (const key of keys) if (!filterLookup.has(key)) filterLookup.set(key, candidate.type);
  }
  const entityFilterConflicts = [...shared].map((group) => group.split('/'));
  const conflictKey = JSON.stringify([...shared].sort());
  if (entityFilterConflicts.length > 0 && !loggedFilterConflicts.has(conflictKey)) {
    if (loggedFilterConflicts.size < 100) loggedFilterConflicts.add(conflictKey);
    // Static text and a count only (no app data in logs); `entityFilterConflicts` names the types.
    console.warn(`[glirastes] chatInteractions: ${entityFilterConflicts.length} group(s) of entity types share a label or alias in this language; it selects none of them in @<name>: (their other aliases and the type itself still do). See registry.entityFilterConflicts.`);
  }

  const readMentionContext = (): ChatMentionContext | undefined => {
    const source = config.mentionContext;
    try {
      const value = typeof source === 'function' ? source() : source;
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  };
  /** Entity types in list order: the context's preferred types first, then the declared order. */
  const orderedTypes = (): string[] => {
    const all = [...entities.keys()];
    const preferred = readMentionContext()?.preferredTypes;
    if (!Array.isArray(preferred) || preferred.length === 0) return all;
    const first = [...new Set((preferred as ReadonlyArray<unknown>).filter(
      (type): type is string => typeof type === 'string' && entities.has(type),
    ))];
    return [...first, ...all.filter((type) => !first.includes(type))];
  };
  const entityFilter = (query: string): { type: string; text: string } | undefined => {
    if (typeof query !== 'string') return undefined;
    const colon = query.indexOf(':');
    if (colon <= 0) return undefined;
    for (const key of nameKeys(query.slice(0, colon))) {
      const type = filterLookup.get(key);
      if (type) return { type, text: query.slice(colon + 1) };
    }
    return undefined;
  };

  const commandProvider: ChatCompletionProvider = {
    id: 'chat-commands',
    trigger: '/',
    search({ query, limit }) {
      const group = text('commandsGroup');
      return [...commands.values()]
        .map((command) => {
          const label = chatText(command.label, locale);
          return { command, label, rank: rank(label, command, query) };
        })
        .filter((entry): entry is { command: ChatCommandDefinition; label: string; rank: number } => entry.rank !== undefined)
        .sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
        .slice(0, limit)
        .map(({ command, label }): CompletionItem => {
          const description = chatText(command.description, locale);
          const run = command.run;
          return {
            id: command.id,
            type: 'command',
            label,
            ...(description ? { description } : {}),
            ...(command.icon ? { icon: command.icon } : {}),
            group,
            // A command mixed with free text goes to the model with its tool reference.
            ...(run.kind !== 'prompt' ? { definitionId: run.tool, ...(run.args ? { args: run.args } : {}) } : {}),
          };
        });
    },
  };

  // `@ta` also offers `Task:`, which narrows the list to that type (above the hits, which still search every type).
  const entityTypeProvider: ChatCompletionProvider = {
    id: 'chat-entity-types',
    trigger: '@',
    search({ query }) {
      if (searchableTypes.length < 2 || typeof query !== 'string' || query.includes(':')) return [];
      const folded = fold(query);
      const transliterated = transliterate(query);
      if (!folded) return [];
      return orderedTypes()
        .filter((type) => (filterNames.get(type) ?? []).some((name) => (
          fold(name).startsWith(folded) || transliterate(name).startsWith(transliterated)
        )))
        .slice(0, MAX_TYPE_SUGGESTIONS)
        .map((type): CompletionItem => {
          const entity = entities.get(type)!;
          const name = `${filterNames.get(type)![0]!}:`;
          return {
            id: type,
            type: ENTITY_TYPE_FILTER_ITEM_TYPE,
            label: name,
            description: fillTemplate(text('entityTypeFilter'), { type: chatText(entity.label, locale) }),
            ...(entity.icon ? { icon: entity.icon } : {}),
            group: text('entityTypesGroup'),
            select: 'query',
            insertText: name,
          };
        });
    },
  };

  const entityProvider: ChatCompletionProvider = {
    id: 'chat-entities',
    trigger: '@',
    async search({ query, signal, limit, context }) {
      // `@task:rel` searches only `task` for `rel`; any other query searches every type.
      const filter = entityFilter(query);
      const types = filter ? [filter.type] : orderedTypes();
      const searched = filter ? filter.text : query;
      const settled = await Promise.allSettled(types.map((type) => entities.get(type)!).map(async (entity) => {
        const items = await entity.search(searched, { signal, limit, locale, context });
        return (Array.isArray(items) ? items : []).slice(0, limit).map((item): CompletionItem => {
          const card = entity.card?.(item);
          const description = card?.subtitle ?? item.description;
          return {
            id: item.id,
            type: entity.type,
            label: card?.title ?? item.label,
            ...(description ? { description } : {}),
            ...(entity.icon ? { icon: entity.icon } : {}),
            ...(entity.actions?.length
              ? { actions: entity.actions.map((action) => ({ id: action.id, label: chatText(action.label, locale) })) }
              : {}),
            group: chatText(entity.label, locale),
          };
        });
      }));
      // One entity type must not fill the whole per-provider cap: take one hit per type in turn.
      const lists = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const interleaved: CompletionItem[] = [];
      for (let index = 0; index < limit && interleaved.length < limit; index += 1) {
        for (const list of lists) {
          const item = list[index];
          if (item && interleaved.length < limit) interleaved.push(item);
        }
      }
      return interleaved;
    },
  };

  const complete = (
    pending: PendingChatCommand,
    values: Readonly<Record<string, string>>,
    labels: Readonly<Record<string, string>> = {},
  ): ChatSendPlan => {
    const valueLabels = { ...pending.valueLabels, ...labels };
    const merged: Record<string, string> = { ...pending.values };
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.trim()) merged[name] = value.trim();
      else delete merged[name];
    }
    const missing = pending.args.some((arg) => arg.required && !merged[arg.name]);
    if (missing) return { status: 'needs-args', request: { ...pending, values: merged, valueLabels } };
    const args: Record<string, unknown> = structuredClone({ ...pending.fixedArgs });
    for (const [name, value] of Object.entries(merged)) {
      if (isChatArgumentPath(name)) setPath(args, name, value);
    }
    if (serializeChatCommandArgs(args) === undefined) {
      return { status: 'needs-args', request: { ...pending, values: merged, valueLabels, error: 'invalid' } };
    }
    const shown = pending.args
      .filter((arg) => merged[arg.name])
      .map((arg) => (arg.entity ? `@${valueLabels[arg.name] || merged[arg.name]}` : merged[arg.name]!));
    const entityLabels = Object.entries(valueLabels)
      .filter(([name]) => !pending.args.some((arg) => arg.name === name))
      .map(([, label]) => `@${label}`);
    return {
      status: 'send',
      text: formatChatCommandMessage({
        commandId: pending.commandId,
        tool: pending.tool,
        args,
        label: [`/${pending.label}`, ...entityLabels, ...shown].join(' '),
      }),
    };
  };

  /** Ask once when a command has arguments and none were given; otherwise send when nothing required is missing. */
  const plan = (pending: PendingChatCommand, given: number): ChatSendPlan => (
    pending.args.length > 0 && given === 0
      ? { status: 'needs-args', request: pending }
      : complete(pending, {})
  );

  return {
    locale,
    providers: [commandProvider, entityTypeProvider, entityProvider],
    entitySearches: (config.data?.entities ?? []).flatMap((entity) => (
      entity.search ? [{ type: entity.type, search: entity.search }] : []
    )),
    command: (id) => commands.get(id),
    entity: (type) => entities.get(type),
    completeCommand: complete,
    entityFilter,
    entityFilterNames: (type) => [...(filterNames.get(type) ?? [])],
    entityFilterConflicts,
    completionPreset(trigger) {
      if (trigger !== '@') return undefined;
      const type = readMentionContext()?.presetType;
      const name = typeof type === 'string' ? filterNames.get(type)?.[0] : undefined;
      return name ? `${name}:` : undefined;
    },

    async searchEntity(type, query, signal) {
      const entity = entities.get(type);
      if (!entity) return [];
      try {
        const items = await entity.search(query, { signal, limit: argumentLimit, locale, context: config.context ?? {} });
        return (Array.isArray(items) ? items : [])
          .map(toChatEntityItem)
          .filter((item): item is ChatEntityItem => item !== undefined)
          .slice(0, argumentLimit);
      } catch {
        return [];
      }
    },

    planMessage(text, mentions) {
      const picked = mentions.filter((mention) => mention.type === 'command' && commands.has(String(mention.id)));
      if (picked.length !== 1) return undefined;
      const mention = picked[0]!;
      const command = commands.get(String(mention.id))!;
      const token = tokenOf(mention);
      if (!token) return undefined;
      const rest = withoutToken(text, token);
      if (!rest.found) return undefined;
      if (command.run.kind === 'prompt') {
        const prompt = `${chatText(command.run.prompt, locale)} `;
        // A function replacer: the prompt is the app's text, `$&` and `$$` in it stay as written.
        return { status: 'prompt', text: rest.text.replace(/^\s*/, () => prompt).trim() };
      }
      const values: Record<string, string> = {};
      const valueLabels: Record<string, string> = {};
      let remaining = rest.text;
      const entityMentions = mentions.filter((entry) => entry !== mention && entry.type !== 'command');
      const used = new Set<MentionData>();
      for (const arg of command.args ?? []) {
        if (!arg.entity) continue;
        const match = entityMentions.find((entry) => entry.type === arg.entity && !used.has(entry));
        if (!match) continue;
        used.add(match);
        values[arg.name] = String(match.id);
        valueLabels[arg.name] = typeof match.label === 'string' ? match.label : String(match.id);
      }
      // Values the pill carries (`insertCommand(id, args)`) fill the remaining arguments.
      let preset = 0;
      if (typeof mention.args === 'object' && mention.args !== null && !Array.isArray(mention.args)) {
        for (const arg of command.args ?? []) {
          if (values[arg.name]) continue;
          const value = valueAt(mention.args as Record<string, unknown>, arg.name);
          if (typeof value !== 'string' || !value.trim()) continue;
          values[arg.name] = value.trim();
          preset += 1;
        }
      }
      for (const entry of used) {
        const entryToken = tokenOf(entry);
        if (entryToken) remaining = withoutToken(remaining, entryToken).text;
      }
      // Free text or unused references: the model decides, with the command as a tool reference.
      if (remaining.trim() || used.size !== entityMentions.length) return undefined;
      return plan({
        commandId: command.id,
        tool: command.run.tool,
        label: chatText(command.label, locale),
        fixedArgs: command.run.args ?? {},
        args: command.args ?? [],
        values,
        valueLabels,
      }, used.size + preset);
    },

    planAction(target, actionId) {
      const action = entities.get(target.type)?.actions?.find((entry) => entry.id === actionId);
      if (!action) return undefined;
      return plan({
        commandId: action.id,
        tool: action.run.tool,
        label: chatText(action.label, locale),
        fixedArgs: action.run.args ?? {},
        args: action.args ?? [],
        values: { [action.entityArg]: target.id },
        valueLabels: { [action.entityArg]: target.label },
      }, 0);
    },
  };
}
