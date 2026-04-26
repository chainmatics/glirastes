import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { UseAiChatReturn } from '../types.js';

/**
 * Hook for accessing the core chat functionality.
 *
 * Must be used within an `<AiChatProvider>`.
 *
 * @example
 * ```tsx
 * function MyChat() {
 *   const { messages, send, isLoading, clear } = useAiChat();
 *
 *   return (
 *     <div>
 *       {messages.map(m => <div key={m.id}>{m.parts[0]?.text}</div>)}
 *       <button onClick={() => send('hello')}>Send</button>
 *       <button onClick={clear}>Clear</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAiChat(): UseAiChatReturn {
  const ctx = useChatContext();

  return useMemo(
    () => ({
      messages: ctx.messages,
      send: ctx.send,
      stop: ctx.stop,
      isLoading: ctx.isLoading,
      error: ctx.error,
      loadMore: ctx.loadMore,
      hasMore: ctx.hasMore,
      clear: ctx.clear,
      pipelineSteps: ctx.pipelineSteps,
      pipelineState: ctx.pipelineState,
    }),
    [
      ctx.messages,
      ctx.send,
      ctx.stop,
      ctx.isLoading,
      ctx.error,
      ctx.loadMore,
      ctx.hasMore,
      ctx.clear,
      ctx.pipelineSteps,
      ctx.pipelineState,
    ],
  );
}
