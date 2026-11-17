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
import { getDefaultUiActionBus } from '../../browser/ui-action-bus.js';
import type {
  ChatTransport,
  ChatTransportConfig,
  ChatTransportDataHandler,
  ChatMessage,
  FilePart,
} from '../types.js';
import { limitRequestAttachments } from '../utils/attachments.js';
import { MEMORY_BODY_FIELD, MEMORY_MAX_USER_NOTES, MEMORY_NOTES_PART, readMemoryEntries } from '../../contracts/memory.js';
import type { BrowserMemoryStore } from '../utils/local-memory-store.js';

/**
 * Body of each chat request: the client actions the open page handles, so
 * the server refuses the others, plus the host's extras.
 * @internal
 */
export function chatRequestBody(
  extras: Record<string, unknown> | (() => Record<string, unknown>) | undefined,
  memory?: BrowserMemoryStore,
): Record<string, unknown> {
  const resolved = !extras ? {} : typeof extras === 'function' ? extras() : extras;
  return {
    glirastesClientActions: getDefaultUiActionBus().registeredActionIds(),
    ...(memory ? { [MEMORY_BODY_FIELD]: { user: memory.read() } } : {}),
    ...resolved,
  };
}

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
  /**
   * Browser-side notes for a handler with `memory.user: true` (see
   * `createLocalMemoryStore`): sent with every request, replaced when the
   * model adds or removes one. Not needed when the handler has a store.
   */
  memory?: BrowserMemoryStore;
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
    memory,
  } = options;

  const memoryRef = useRef(memory);
  memoryRef.current = memory;

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
        body: () => chatRequestBody(bodyExtrasRef.current, memoryRef.current),
        // Same body as the default, with file data only in the latest user turns.
        prepareSendMessagesRequest: ({ body, id, messages, trigger, messageId }) => ({
          body: {
            ...body,
            id,
            messages: limitRequestAttachments(messages as unknown as ChatMessage[]),
            trigger,
            messageId,
          },
        }),
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
      if (part.type === MEMORY_NOTES_PART && memoryRef.current) {
        const notes = (part.data as { user?: unknown } | null)?.user;
        if (Array.isArray(notes)) memoryRef.current.write(readMemoryEntries(notes, MEMORY_MAX_USER_NOTES));
      }
      onDataRef.current?.(part);
      subscribersRef.current.forEach((fn) => fn(part));
    },
  });

  const send = useCallback(
    ({ text, files }: { text: string; files?: FilePart[] }) => {
      if (!files || files.length === 0) return sendMessage({ text });
      return text === '' ? sendMessage({ parts: files }) : sendMessage({ text, files });
    },
    [sendMessage],
  );

  return useMemo<ChatTransport>(
    () => ({
      messages: rawMessages as unknown as ChatMessage[],
      status,
      error: error ?? null,
      sendMessage: send,
      stop,
      setMessages: setMessages as unknown as ChatTransport['setMessages'],
      addToolApprovalResponse,
      subscribeToData,
    }),
    [rawMessages, status, error, send, stop, setMessages, addToolApprovalResponse, subscribeToData],
  );
}
