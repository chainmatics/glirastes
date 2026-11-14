import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { chatText, type ChatLocaleCode } from '../../contracts/chat-interactions.js';
import { useOptionalAssistantLayout } from '../assistant/assistant-layout.js';
import { toChatEntityItem, type ChatCommandDefinition } from '../interactions/definitions.js';
import type { ChatInteractionRegistry } from '../interactions/registry.js';
import { ChatContext } from '../provider/chat-context.js';
import type { MentionData, RichMentionInputHandle } from '../types.js';
import { normalizeMentionSlug } from '../utils/mention-markup.js';

/** Something the user can talk about: a task, a team, a person. */
export interface ChatComposerEntity {
  readonly type: string;
  readonly id: string;
  /** Shown in the pill; looked up through the entity's `resolve` when missing. */
  readonly label?: string;
}

/** What the app asks the composer to do; the mounted composer carries it out in order. */
export type ChatComposerOperation =
  | { readonly kind: 'insert'; readonly mention: MentionData }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'draft'; readonly text: string; readonly mentions: ReadonlyArray<MentionData> }
  | { readonly kind: 'clear' }
  | { readonly kind: 'focus' };

export interface ChatAboutOptions {
  /** A `/` command placed before the entity, e.g. `taskDetails.open` or a prompt command. */
  readonly command?: string;
  /** Values for the command's arguments (by argument name); they skip the form. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Text after the pills, e.g. a question. */
  readonly text?: string;
  /** Keep what is already in the composer and add to it. Default: replace the draft. */
  readonly append?: boolean;
}

/** Programmatic access to the chat composer, e.g. for a "Chat about this" menu entry. */
export interface ChatComposer {
  /** Asks the app to show the chat (`onOpenRequest`, else the surrounding `AssistantLayoutProvider`). */
  open(): void;
  focus(): void;
  /** Replaces the draft; tokens of `mentions` (`@slug`, `/slug`) in `text` become pills. */
  setDraft(text: string, mentions?: ReadonlyArray<MentionData>): void;
  /** Adds text at the end of the draft. */
  insertText(text: string): void;
  clear(): void;
  /** Adds an `@` pill. False when no label is given and the entity cannot `resolve` one. */
  insertMention(entity: ChatComposerEntity): Promise<boolean>;
  /** Adds a `/` pill for a known command. False when the chat has no such command. */
  insertCommand(commandId: string, args?: Readonly<Record<string, unknown>>): boolean;
  /** Opens the chat and puts the command (optional), the entity and the text into the composer. */
  chatAbout(entity: ChatComposerEntity, options?: ChatAboutOptions): Promise<boolean>;
  hasCommand(commandId: string): boolean;
  hasEntity(type: string): boolean;
  /** Label for a "Chat about this" entry in the chat's language (`locale.chatAboutLabel`). */
  readonly chatAboutLabel: string;
}

/** The `@` pill of an entity, shaped like a mention picked from the list. */
export function entityMention(entity: ChatComposerEntity & { readonly label: string }): MentionData {
  return {
    id: entity.id,
    type: entity.type,
    label: entity.label,
    displayName: entity.label,
    prefix: '@',
    slug: normalizeMentionSlug(entity.label) || normalizeMentionSlug(entity.id) || entity.type,
  };
}

/**
 * The `/` pill of a command, shaped like a picked command: a tool-backed
 * command keeps its tool and arguments, so it runs directly when sent alone
 * and reaches the model as a tool reference otherwise.
 */
export function commandMention(
  command: ChatCommandDefinition,
  locale: ChatLocaleCode,
  args?: Readonly<Record<string, unknown>>,
): MentionData {
  const label = chatText(command.label, locale);
  const run = command.run;
  const merged = run.kind !== 'prompt' && (run.args || args) ? { ...(run.args ?? {}), ...(args ?? {}) } : undefined;
  return {
    id: command.id,
    type: 'command',
    label,
    displayName: label,
    prefix: '/',
    slug: normalizeMentionSlug(label) || normalizeMentionSlug(command.id) || 'command',
    ...(run.kind !== 'prompt' ? { definitionId: run.tool, ...(merged ? { args: merged } : {}) } : {}),
  };
}

interface ChatComposerQueue {
  readonly version: number;
  push(operations: ReadonlyArray<ChatComposerOperation>): void;
  take(): ChatComposerOperation[];
  requestOpen(): void;
}

const ChatComposerQueueContext = createContext<ChatComposerQueue | null>(null);

/** Holds composer operations until a composer is mounted; rendered by `AiChatProvider`. */
export function ChatComposerQueueProvider({
  onOpenRequest,
  children,
}: {
  onOpenRequest?: () => void;
  children: ReactNode;
}) {
  const layout = useOptionalAssistantLayout();
  const queue = useRef<ChatComposerOperation[]>([]);
  const [version, setVersion] = useState(0);
  const openRef = useRef<() => void>(() => {});
  openRef.current = () => {
    if (onOpenRequest) onOpenRequest();
    else layout?.openChat();
  };
  const push = useCallback((operations: ReadonlyArray<ChatComposerOperation>) => {
    if (operations.length === 0) return;
    queue.current = [...queue.current, ...operations];
    setVersion((current) => current + 1);
  }, []);
  const take = useCallback(() => {
    const taken = queue.current;
    queue.current = [];
    return taken;
  }, []);
  const requestOpen = useCallback(() => openRef.current(), []);
  const value = useMemo(() => ({ version, push, take, requestOpen }), [version, push, take, requestOpen]);
  return <ChatComposerQueueContext.Provider value={value}>{children}</ChatComposerQueueContext.Provider>;
}

function useComposerQueue(): ChatComposerQueue {
  const queue = useContext(ChatComposerQueueContext);
  if (!queue) throw new Error('useChatComposer must be used within an <AiChatProvider>');
  return queue;
}

async function labelOf(entity: ChatComposerEntity, registry: ChatInteractionRegistry | undefined): Promise<string | undefined> {
  if (entity.label?.trim()) return entity.label.trim();
  const resolve = registry?.entity(entity.type)?.resolve;
  if (!resolve) return undefined;
  try {
    return toChatEntityItem(await resolve(entity.id))?.label;
  } catch {
    return undefined;
  }
}

/**
 * Programmatic composer: open the chat and put pills and text into its input
 * from anywhere below `AiChatProvider`. Works with the default composer and
 * with any composer that calls `useChatComposerTarget`.
 *
 * @example
 * ```tsx
 * const composer = useChatComposer();
 * <MenuItem onSelect={() => composer.chatAbout({ type: 'task', id: task.id, label: task.title })}>
 *   {composer.chatAboutLabel}
 * </MenuItem>
 * ```
 */
export function useChatComposer(): ChatComposer {
  const composer = useOptionalChatComposer();
  if (!composer) throw new Error('useChatComposer must be used within an <AiChatProvider>');
  return composer;
}

/** `useChatComposer` for components that also render without a chat: null outside `AiChatProvider`. */
export function useOptionalChatComposer(): ChatComposer | null {
  const queue = useContext(ChatComposerQueueContext);
  const chat = useContext(ChatContext);
  const push = queue?.push;
  const requestOpen = queue?.requestOpen;
  const interactions = chat?.interactions;
  const chatAboutLabel = chat?.locale.chatAboutLabel ?? '';
  const registryRef = useRef(interactions);
  registryRef.current = interactions;
  const languageRef = useRef<ChatLocaleCode>(interactions?.locale ?? 'en');
  languageRef.current = interactions?.locale ?? 'en';

  return useMemo<ChatComposer | null>(() => {
    if (!push || !requestOpen) return null;
    const command = (commandId: string, args?: Readonly<Record<string, unknown>>) => {
      const definition = registryRef.current?.command(commandId);
      return definition ? commandMention(definition, languageRef.current, args) : undefined;
    };
    const mention = async (entity: ChatComposerEntity) => {
      const label = await labelOf(entity, registryRef.current);
      return label ? entityMention({ ...entity, label }) : undefined;
    };
    return {
      open: requestOpen,
      focus: () => push([{ kind: 'focus' }]),
      setDraft: (text, mentions = []) => push([{ kind: 'draft', text, mentions }]),
      insertText: (text) => push([{ kind: 'text', text }]),
      clear: () => push([{ kind: 'clear' }]),
      async insertMention(entity) {
        const pill = await mention(entity);
        if (!pill) return false;
        push([{ kind: 'insert', mention: pill }]);
        return true;
      },
      insertCommand(commandId, args) {
        const pill = command(commandId, args);
        if (!pill) return false;
        push([{ kind: 'insert', mention: pill }]);
        return true;
      },
      async chatAbout(entity, options = {}) {
        requestOpen();
        const pill = await mention(entity);
        if (!pill) return false;
        const commandPill = options.command ? command(options.command, options.args) : undefined;
        if (options.command && !commandPill) return false;
        push([
          ...(options.append ? [] : [{ kind: 'clear' } as const]),
          ...(commandPill ? [{ kind: 'insert', mention: commandPill } as const] : []),
          { kind: 'insert', mention: pill },
          ...(options.text?.trim() ? [{ kind: 'text', text: options.text.trim() } as const] : []),
          { kind: 'focus' },
        ]);
        return true;
      },
      hasCommand: (commandId) => registryRef.current?.command(commandId) !== undefined,
      hasEntity: (type) => registryRef.current?.entity(type) !== undefined,
      chatAboutLabel,
    };
  }, [push, requestOpen, chatAboutLabel]);
}

/**
 * Connects a composer built on `RichMentionInput` to `useChatComposer`:
 * queued operations run as soon as the editor is mounted. `onChange`
 * receives the new value after each batch (e.g. to enable Send).
 */
export function useChatComposerTarget(
  handleRef: RefObject<RichMentionInputHandle | null>,
  options: { onChange?: (value: string) => void; enabled?: boolean } = {},
): void {
  const { version, take } = useComposerQueue();
  const onChangeRef = useRef(options.onChange);
  onChangeRef.current = options.onChange;
  const enabled = options.enabled ?? true;
  useEffect(() => {
    const handle = handleRef.current;
    if (!enabled || !handle) return;
    const operations = take();
    if (operations.length === 0) return;
    let focus = false;
    for (const operation of operations) {
      switch (operation.kind) {
        case 'insert':
          handle.insertMention(operation.mention);
          break;
        case 'text': {
          const current = handle.getValue();
          handle.setValue(current ? `${current} ${operation.text}` : operation.text, handle.getMentions());
          break;
        }
        case 'draft':
          handle.setValue(operation.text, [...operation.mentions]);
          break;
        case 'clear':
          handle.clear();
          break;
        case 'focus':
          focus = true;
          break;
      }
    }
    onChangeRef.current?.(handle.getValue());
    if (focus) requestAnimationFrame(() => handle.focus());
  }, [version, take, handleRef, enabled]);
}
