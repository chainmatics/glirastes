import { createContext, useContext } from 'react';
import { ChatContext, useChatContext, type ChatContextValue } from './chat-context.js';
import type { ComposerContextValue } from './composer-context.js';
import { readClarificationPart } from '../utils/clarification.js';
import { turnStartId } from '../utils/turn-outcomes.js';
import type { ChatMessage, PendingApproval } from '../types.js';

type FullChat = ChatContextValue & ComposerContextValue;

/**
 * Internal: the chat fields a message bubble and the SDK's own components in
 * it read (`useMessageParts`, `MessageBubble`, Markdown, chips, activity log,
 * approval entry and card, clarification card, footer). Only these are
 * readable through `useMessageChat`, so a bubble cannot depend on a field that
 * `MessageList` does not track for it.
 */
const MESSAGE_CHAT_KEYS = [
  'classNames',
  'components',
  'locale',
  'language',
  'toolResults',
  'toolRendererRegistry',
  'toolLabels',
  'activityLog',
  'approvalDescription',
  'approvalSubjects',
  'approvalDisplay',
  'entityDeclarations',
  'mentionPrefix',
  'composer',
  'messageFooter',
  // Below: not compared as they are. Called only (stable functions that call the current one; whether
  // `continueAfterBudgetStop` is there is compared), or changing while a turn runs: `MessageList` tracks what
  // a message reads of them.
  'suggestions',
  'approve',
  'reject',
  'stop',
  'continueAfterBudgetStop',
  'turnWorkedMs',
  'messages',
  'isLoading',
  'isTurnRunning',
  'canCompose',
  'send',
  'selectSuggestion',
  'pipelineState',
  'pendingApprovals',
  'isProcessingApproval',
  'isApprovalResendPending',
  'turnOutcomes',
] as const satisfies ReadonlyArray<keyof FullChat>;

/** The fields compared as they are: a new value renders every message again. */
const STATIC_KEYS = MESSAGE_CHAT_KEYS.slice(0, MESSAGE_CHAT_KEYS.indexOf('suggestions'));

export type MessageChat = Pick<FullChat, typeof MESSAGE_CHAT_KEYS[number]>;

/**
 * A message's view of the chat inside `MessageList`: every field read from
 * the chat value `MessageList` rendered last, so a bubble always reads the
 * current values; the object itself is replaced only when something the
 * message shows changed, which renders the bubble again.
 */
const MessageChatContext = createContext<MessageChat | null>(null);
export const MessageChatProvider = MessageChatContext.Provider;

/**
 * Internal: the chat as a message bubble reads it. Inside `MessageList` the
 * message's view (re-renders only when the message is affected), elsewhere
 * the chat context as before (re-renders with every change of it).
 */
export function useMessageChat(): MessageChat {
  const scoped = useContext(MessageChatContext);
  // A component is inside a message of `MessageList` or not for its whole life: the hooks keep their order.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return scoped ?? (useChatContext() as FullChat);
}

/** `useMessageChat` that returns null outside a provider (Markdown rendered on its own). */
export function useOptionalMessageChat(): MessageChat | null {
  const scoped = useContext(MessageChatContext);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return scoped ?? (useContext(ChatContext) as FullChat | null);
}

interface CachedView { key: unknown[]; view: MessageChat }

/**
 * Per `MessageList`: gives each message its view of the chat. A finished
 * message keeps its view (and its bubble does not render) while nothing it
 * reads changed: the message object, the config fields (`STATIC_KEYS`, the
 * `suggestions` fields), whether the next message is a user message, its
 * turn's outcome and, with an approval waiting at one of its parts, the open
 * approval and whether one is being sent. A message with a clarification, or
 * with an approval where approvals show at their part or an app's bubble or
 * parts may read them, also reads the conversation (names of the approval's
 * records, whether the question was answered): it gets a new view when a
 * message that is not streaming changes. The latest message also gets a new
 * view when the state of the running turn changes (loading, pipeline state,
 * open approvals, outcomes, whether an answered approval is still to be sent).
 */
export function createMessageChats() {
  const live: { current: FullChat | null } = { current: null };
  const proto = {} as MessageChat;
  for (const key of MESSAGE_CHAT_KEYS) {
    // A function field is one stable function that calls the chat's current one when it is called: a click
    // handler made in a render the message did not repeat (it renders only when what it shows changes) never
    // sends through an outdated `send` (its mentions, `onBeforeSend`, queue state). Absent stays absent.
    let forward: ((...args: unknown[]) => unknown) | undefined;
    Object.defineProperty(proto, key, {
      enumerable: true,
      get: () => {
        const value = live.current?.[key];
        if (typeof value !== 'function') return value;
        forward ??= (...args: unknown[]) => (live.current?.[key] as ((...args: unknown[]) => unknown) | undefined)?.(...args);
        return forward;
      },
    });
  }
  let views = new Map<string, CachedView>();
  let staticToken: unknown[] = [];
  let settled: { messages: ReadonlyArray<ChatMessage>; token: object } = { messages: [], token: {} };

  return function messageChats(chat: FullChat, messages: ReadonlyArray<ChatMessage>): (message: ChatMessage, index: number) => MessageChat {
    live.current = chat;
    const nextStatic: unknown[] = STATIC_KEYS.map((key) => chat[key]);
    nextStatic.push(
      chat.suggestions?.placement, chat.suggestions?.count, chat.suggestions?.enabled,
      // The "Continue" button shows only while the chat can continue.
      chat.continueAfterBudgetStop !== undefined,
    );
    // Compared by identity, as React compares props: a new config object renders every message.
    if (!sameValues(staticToken, nextStatic)) staticToken = nextStatic;
    // The messages that are not streaming: all of them, without the latest one while a turn runs.
    const stable = chat.isLoading ? messages.slice(0, -1) : messages;
    if (!sameValues(settled.messages, stable)) settled = { messages: stable, token: {} };
    const outcomes = chat.turnOutcomes && chat.turnOutcomes.size > 0 ? chat.turnOutcomes : null;
    // Where approvals show at their part, or an app's bubble or parts may read `MessagePartEntry.approval`.
    const display = chat.approvalDisplay;
    const readsApprovals = (display !== undefined && (display.decided !== 'none' || display.open !== 'panel'))
      || chat.components?.MessageParts !== undefined || chat.components?.MessageBubble !== undefined;
    const pending = chat.pendingApprovals ?? [];
    const previous = views;
    const next = new Map<string, CachedView>();
    views = next;

    return (message, index) => {
      const key: unknown[] = index === messages.length - 1
        // The latest message reads the running turn (its log, notice, footer, follow-ups, approvals): every
        // field that changes while a turn runs, except `send` and `selectSuggestion` (called on a click only).
        ? [
          'latest', staticToken, message, chat.isLoading, chat.isTurnRunning, chat.canCompose, chat.pipelineState,
          chat.pendingApprovals, chat.isProcessingApproval, chat.turnOutcomes,
          outcomeOf(message), ...conversationKey(message, true),
        ]
        : finishedKey(message, index);
      const cached = previous.get(message.id);
      if (cached && sameValues(cached.key, key)) {
        next.set(message.id, cached);
        return cached.view;
      }
      const view = Object.create(proto) as MessageChat;
      next.set(message.id, { key, view });
      return view;
    };

    function finishedKey(message: ChatMessage, index: number): unknown[] {
      const following = messages[index + 1];
      return [
        'finished',
        staticToken,
        message,
        !following || following.role === 'user',
        outcomeOf(message),
        ...conversationKey(message),
      ];
    }

    /** The outcome of the message's turn (found from the messages before it). */
    function outcomeOf(message: ChatMessage): unknown {
      const turnId = outcomes ? turnStartId(messages as ChatMessage[], message.id) : null;
      return (turnId ? outcomes?.get(turnId) : undefined) ?? null;
    }

    /** What a message reads of its open approvals and of the conversation (approval names, answered questions). */
    function conversationKey(message: ChatMessage, latest = false): unknown[] {
      const key: unknown[] = [];
      let conversation = false;
      for (const part of message.parts) {
        if (!isRecord(part)) continue;
        if (isRecord(part.approval)) {
          if (readsApprovals) conversation = true;
          // The latest answer asks whether an answered approval is still to be sent (a new function per change).
          if (latest) key.push(chat.isApprovalResendPending?.((part.approval as { id?: unknown }).id as string));
          if (part.state === 'approval-requested') {
            key.push(chat.isProcessingApproval, pending.find((approval: PendingApproval) => approval.id === (part.approval as { id?: unknown }).id));
          }
        } else if (readClarificationPart(part)) {
          conversation = true;
        }
      }
      if (conversation) key.push(settled.token);
      return key;
    }
  };
}

function sameValues(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
