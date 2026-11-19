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
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type FileUIPart } from 'ai';
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
import { UI_OUTCOME_PROTOCOL_VERSION, UI_OUTCOMES_REQUEST_FIELD } from '../../contracts/ui-outcome.js';
import { shouldContinueChat } from '../utils/ui-outcome-continuation.js';
import type { BrowserMemoryStore } from '../utils/local-memory-store.js';

/**
 * Body of each chat request: the client actions the open page handles, so
 * the server refuses the others, plus the host's extras.
 * @internal
 */
export function chatRequestBody(
  extras: Record<string, unknown> | (() => Record<string, unknown>) | undefined,
  memory?: BrowserMemoryStore,
  reportsUiOutcomes = false,
): Record<string, unknown> {
  const resolved = !extras ? {} : typeof extras === 'function' ? extras() : extras;
  return {
    glirastesClientActions: getDefaultUiActionBus().registeredActionIds(),
    // The chat reports UI outcomes and sends the history again (protocol version 1).
    ...(reportsUiOutcomes ? { [UI_OUTCOMES_REQUEST_FIELD]: UI_OUTCOME_PROTOCOL_VERSION } : {}),
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
  /**
   * Outcome protocol of UI actions (default true): once an `AiChatProvider`
   * reports outcomes through this transport, every request says so
   * (`glirastesUiOutcomes: 1`), the provider writes each outcome into its
   * tool result, and the transport sends the history again once every
   * result that waits for one has it. `false` sends neither.
   */
  uiActionOutcomes?: boolean;
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
    uiActionOutcomes = true,
  } = options;

  const memoryRef = useRef(memory);
  memoryRef.current = memory;

  // Set by the provider that reports outcomes through this transport.
  const reportingRef = useRef(false);
  const uiActionOutcomesRef = useRef(uiActionOutcomes);
  uiActionOutcomesRef.current = uiActionOutcomes;
  const setUiOutcomeReporting = useCallback((enabled: boolean) => {
    reportingRef.current = enabled;
  }, []);
  const reportsUiOutcomes = () => uiActionOutcomesRef.current && reportingRef.current;
  const autoResumeRef = useRef(autoResumeOnApproval);
  autoResumeRef.current = autoResumeOnApproval;

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
        body: () => chatRequestBody(bodyExtrasRef.current, memoryRef.current, reportsUiOutcomes()),
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
    addToolOutput,
  } = useChat({
    transport,
    // With the outcome protocol: approvals answered and every UI outcome reported (see shouldContinueChat).
    sendAutomaticallyWhen: uiActionOutcomes
      ? (options) => (reportsUiOutcomes()
        ? shouldContinueChat(options, { approvals: autoResumeRef.current })
        : autoResumeRef.current && lastAssistantMessageIsCompleteWithApprovalResponses(options))
      : autoResumeOnApproval
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
      // Only the open metadata record differs from the SDK's JSON-typed one.
      const uiFiles = files as FileUIPart[];
      return text === '' ? sendMessage({ parts: uiFiles }) : sendMessage({ text, files: uiFiles });
    },
    [sendMessage],
  );

  const writeToolOutput = useCallback<NonNullable<ChatTransport['addToolOutput']>>(
    ({ tool, toolCallId, output }) => (addToolOutput as unknown as (
      value: { tool: string; toolCallId: string; output: unknown },
    ) => Promise<void>)({ tool, toolCallId, output }),
    [addToolOutput],
  );
  // The history as it is, sent again without a new message (a turn continued on a new page).
  const continueTurn = useCallback(() => sendMessage(), [sendMessage]);

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
      ...(uiActionOutcomes ? { addToolOutput: writeToolOutput, continueTurn, setUiOutcomeReporting } : {}),
    }),
    [rawMessages, status, error, send, stop, setMessages, addToolApprovalResponse, subscribeToData,
      uiActionOutcomes, writeToolOutput, continueTurn, setUiOutcomeReporting],
  );
}
