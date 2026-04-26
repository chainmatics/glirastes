/**
 * Vercel AI SDK chat transport.
 *
 * Wraps `useChat` from `@ai-sdk/react` and `DefaultChatTransport` from `ai`
 * into the `ChatTransport` interface. This is the default transport used by
 * `AiChatProvider` when no custom `transport` prop is provided.
 *
 * Requires `@ai-sdk/react` and `ai` as peer dependencies.
 */

import { useCallback, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import type {
  ChatTransport,
  ChatTransportConfig,
  ChatTransportDataHandler,
  ChatMessage,
} from '../types.js';

export interface UseVercelAiChatTransportOptions extends ChatTransportConfig {
  /**
   * When true, automatically resumes generation after all pending
   * approval responses are provided. Default: true.
   */
  autoResumeOnApproval?: boolean;
  /**
   * Extra fields merged into every outgoing request body. Pass a function
   * to re-evaluate per request — use this to forward a session id:
   *
   * ```ts
   * useVercelAiChatTransport({
   *   endpoint: '/api/chat',
   *   bodyExtras: () => ({ sessionId: currentSessionId }),
   * });
   * ```
   */
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
}

export function useVercelAiChatTransport(
  options: UseVercelAiChatTransportOptions,
): ChatTransport {
  const {
    endpoint,
    headers: userHeaders,
    onData,
    autoResumeOnApproval = true,
    bodyExtras,
  } = options;

  const headersRef = useRef(userHeaders);
  headersRef.current = userHeaders;

  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const bodyExtrasRef = useRef(bodyExtras);
  bodyExtrasRef.current = bodyExtras;

  const subscribersRef = useRef<Set<ChatTransportDataHandler>>(new Set());
  const subscribeToData = useCallback((handler: ChatTransportDataHandler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: endpoint,
        headers: userHeaders
          ? () => {
              const h = headersRef.current;
              return typeof h === 'function' ? h() : h ?? {};
            }
          : undefined,
        body: () => {
          const extras = bodyExtrasRef.current;
          if (!extras) return {};
          return typeof extras === 'function' ? extras() : extras;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- headersRef/bodyExtrasRef are stable
    [endpoint, !!userHeaders],
  );

  const {
    messages: rawMessages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    transport,
    sendAutomaticallyWhen: autoResumeOnApproval
      ? lastAssistantMessageIsCompleteWithApprovalResponses
      : undefined,
    onData: (dataPart) => {
      const part = dataPart as { type: string; data: unknown };
      onDataRef.current?.(part);
      subscribersRef.current.forEach((fn) => fn(part));
    },
  });

  return useMemo<ChatTransport>(
    () => ({
      messages: rawMessages as unknown as ChatMessage[],
      status,
      error: error ?? null,
      sendMessage,
      stop,
      setMessages: setMessages as unknown as ChatTransport['setMessages'],
      addToolApprovalResponse,
      subscribeToData,
    }),
    [rawMessages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse, subscribeToData],
  );
}
