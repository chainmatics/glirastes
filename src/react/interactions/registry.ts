import {
  formatChatCommandMessage,
  serializeChatCommandArgs,
} from '../../contracts/chat-command.js';
import {
  chatText,
  isChatArgumentPath,
  type ChatInteractionArg,
  type ChatInteractionsData,
  type ChatLocaleCode,
} from '../../contracts/chat-interactions.js';
import type {
  ChatCompletionProvider,
  CompletionItem,
  CompletionPermissionContext,
  MentionData,
} from '../types.js';
import { normalizeMentionSlug } from '../utils/mention-markup.js';
import {
  entitiesFromData,
  toChatEntityItem,
  type ChatCommandDefinition,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type DerivedEntityOptions,
} from './definitions.js';

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
  /** `/` commands and `@` entities for `createCompletionSearch`. */
  readonly providers: ReadonlyArray<ChatCompletionProvider>;
  command(id: string): ChatCommandDefinition | undefined;
  entity(type: string): ChatEntityDefinition | undefined;
  /** Searches one entity type, e.g. for an argument field; failures yield no hits. */
  searchEntity(type: string, query: string, signal: AbortSignal): Promise<ChatEntityItem[]>;
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

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
}

function rank(label: string, command: ChatCommandDefinition, needle: string): number | undefined {
  if (!needle) return 0;
  const folded = fold(label);
  if (folded.startsWith(needle)) return 0;
  if (folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 1;
  if (folded.includes(needle) || fold(normalizeMentionSlug(label)).includes(needle)) return 2;
  if (fold(command.id).includes(needle)) return 3;
  if ((command.keywords ?? []).some((keyword) => fold(keyword).includes(needle))) return 4;
  return undefined;
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

  const commandProvider: ChatCompletionProvider = {
    id: 'chat-commands',
    trigger: '/',
    search({ query, limit }) {
      const needle = fold(query);
      return [...commands.values()]
        .map((command) => {
          const label = chatText(command.label, locale);
          return { command, label, rank: rank(label, command, needle) };
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
            // A command mixed with free text goes to the model with its tool reference.
            ...(run.kind !== 'prompt' ? { definitionId: run.tool, ...(run.args ? { args: run.args } : {}) } : {}),
          };
        });
    },
  };

  const entityProvider: ChatCompletionProvider = {
    id: 'chat-entities',
    trigger: '@',
    async search({ query, signal, limit, context }) {
      const settled = await Promise.allSettled([...entities.values()].map(async (entity) => {
        const items = await entity.search(query, { signal, limit, locale, context });
        return (Array.isArray(items) ? items : []).slice(0, limit).map((item): CompletionItem => {
          const card = entity.card?.(item);
          const description = card?.subtitle ?? item.description;
          return {
            id: item.id,
            type: entity.type,
            label: card?.title ?? item.label,
            ...(description ? { description } : {}),
            ...(entity.actions?.length
              ? { actions: entity.actions.map((action) => ({ id: action.id, label: chatText(action.label, locale) })) }
              : {}),
          };
        });
      }));
      // One entity type must not fill the whole per-provider cap: take one hit per type in turn.
      const lists = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const interleaved: CompletionItem[] = [];
      for (let index = 0; index < limit; index += 1) {
        for (const list of lists) {
          const item = list[index];
          if (item) interleaved.push(item);
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
    providers: [commandProvider, entityProvider],
    command: (id) => commands.get(id),
    entity: (type) => entities.get(type),
    completeCommand: complete,

    async searchEntity(type, query, signal) {
      const entity = entities.get(type);
      if (!entity) return [];
      try {
        const items = await entity.search(query, { signal, limit: 8, locale, context: config.context ?? {} });
        return (Array.isArray(items) ? items : [])
          .map(toChatEntityItem)
          .filter((item): item is ChatEntityItem => item !== undefined)
          .slice(0, 8);
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
      }, used.size);
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
