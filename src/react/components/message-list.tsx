import { Fragment, memo, useRef, useEffect, useCallback, useState, type ComponentType } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { ComposerContextValue } from '../provider/composer-context.js';
import { createMessageChats, MessageChatProvider, type MessageChat } from '../provider/message-chat-context.js';
import { MessageBubble as DefaultMessageBubble, statusNotice } from './message-bubble.js';
import { TurnNotice as DefaultTurnNotice } from './activity-log.js';
import { turnStartId } from '../utils/turn-outcomes.js';
import type { ChatMessage, MessageBubbleProps, MessageListProps, TurnOutcome } from '../types.js';

/**
 * One message with its view of the chat. Renders again only when the view,
 * the message, the bubble component or the turn outcome is new: a finished
 * message does not render while a later one streams.
 */
const MessageSlot = memo(function MessageSlot({ chat, Bubble, message, outcome }: {
  chat: MessageChat;
  Bubble: ComponentType<MessageBubbleProps>;
  message: ChatMessage;
  outcome: TurnOutcome | null;
}) {
  return (
    <MessageChatProvider value={chat}>
      <Bubble message={message} {...(outcome ? { turnOutcome: outcome } : {})} />
    </MessageChatProvider>
  );
});

/**
 * Scrollable message list with auto-scroll and pagination.
 *
 * Uses the `MessageBubble` component from provider config or the default.
 * Supports `loadMore` for infinite scroll upwards.
 */
export function MessageList({ className }: MessageListProps) {
  const chat = useChatContext();
  const {
    messages, isLoading, hasMore, loadMore, classNames, components, locale, turnOutcomes, activityLog, pendingUiHandoffs,
  } = chat;
  const [messageChats] = useState(createMessageChats);
  const chatOf = messageChats(chat as typeof chat & ComposerContextValue, messages);
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const BubbleComponent = components.MessageBubble ?? DefaultMessageBubble;
  const TurnNoticeComponent = components.TurnNotice ?? DefaultTurnNotice;
  const outcomes = turnOutcomes && turnOutcomes.size > 0 ? turnOutcomes : null;
  const everyNotice = (activityLog?.noticeScope ?? 'every') === 'every';

  // New message: reset user-scroll and force scroll to bottom.
  useEffect(() => {
    userScrolledRef.current = false;
    const el = containerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [messages.length]);

  // Streaming chunks & loading-state changes: keep at bottom unless user scrolled up.
  useEffect(() => {
    if (userScrolledRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [messages, isLoading]);

  // Detect user scroll: programmatic scroll lands at scrollHeight (dist ≈ 0),
  // user scroll-up moves away from bottom (dist > 80).
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist <= 2) userScrolledRef.current = false;
    else if (dist > 80) userScrolledRef.current = true;
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={className ?? classNames.messageList}
      data-component="message-list"
    >
      {hasMore && (
        <button onClick={loadMore} data-action="load-more">
          {locale.loadMoreButton ?? 'Load more'}
        </button>
      )}
      {messages.map((message, index) => {
        const turnId = outcomes ? turnStartId(messages, message.id) : null;
        const outcome = (turnId ? outcomes?.get(turnId) : undefined) ?? null;
        // `noticeScope: 'every'`: a turn that ended before any assistant message shows its notice after its question.
        const next = messages[index + 1];
        const standalone = everyNotice && outcome && message.role === 'user' && (!next || next.role === 'user')
          && !(isLoading && !next)
          ? statusNotice(outcome.status, locale)
          : undefined;
        return (
          <Fragment key={message.id}>
            <MessageSlot chat={chatOf(message, index)} Bubble={BubbleComponent} message={message} outcome={outcome} />
            {pendingUiHandoffs?.filter(handoff => handoff.messageId === message.id).map(handoff => (
              <button type="button" key={handoff.id} data-component="ui-action-handoff" onClick={handoff.open}>
                {handoff.label}
              </button>
            ))}
            {standalone && (
              <TurnNoticeComponent text={standalone.text} status={standalone.status} placement="message" outcome={outcome!} />
            )}
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
