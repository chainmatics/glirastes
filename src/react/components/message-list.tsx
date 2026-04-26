import { useRef, useEffect, useCallback } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { MessageBubble as DefaultMessageBubble } from './message-bubble.js';
import type { MessageListProps } from '../types.js';

/**
 * Scrollable message list with auto-scroll and pagination.
 *
 * Uses the `MessageBubble` component from provider config or the default.
 * Supports `loadMore` for infinite scroll upwards.
 */
export function MessageList({ className }: MessageListProps) {
  const { messages, isLoading, hasMore, loadMore, classNames, components, locale } = useChatContext();
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const BubbleComponent = components.MessageBubble ?? DefaultMessageBubble;

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
      {messages.map((message) => (
        <BubbleComponent key={message.id} message={message} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
