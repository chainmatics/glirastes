/**
 * LangGraph chat transport.
 *
 * A React hook that implements the `ChatTransport` interface against a
 * LangGraph backend that emits Server-Sent Events in the wire format
 * documented below.
 *
 * Unlike the Vercel transport, this transport does NOT import
 * `@langchain/langgraph`, `@langchain/core`, or `ai` at runtime — it is
 * purely a fetch + SSE parser. A consumer's backend is free to use
 * LangGraph JS's native `.stream()` API (or anything else that produces
 * the same event channels) without leaking LangChain types into the
 * frontend bundle.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ChatTransport,
  ChatTransportApprovalResponse,
  ChatTransportConfig,
  ChatTransportDataHandler,
  ChatTransportDataPart,
  ChatMessage,
  MessagePart,
  TextPart,
  ToolInvocationPart,
  ToolResultPart,
} from '../types.js';

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

/** `event: updates` — a LangGraph node finished and produced a state delta. */
export interface LangGraphUpdatesEvent {
  node: string;
  update: Record<string, unknown>;
}

/** `event: message` — an LLM token chunk for the assistant bubble. */
export interface LangGraphMessageEvent {
  content: string;
  node?: string;
  role: 'assistant';
}

/** `event: custom` — domain-specific signal emitted via LangGraph `config.writer()`. */
export interface LangGraphCustomEvent {
  type: string;
  payload: unknown;
}

/** `event: tool_call` — a tool invocation began. */
export interface LangGraphToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** `event: tool_result` — a tool invocation produced a result. */
export interface LangGraphToolResultEvent {
  id: string;
  result: unknown;
}

/** `event: error` — stream-level error. */
export interface LangGraphErrorEvent {
  message: string;
  code?: string;
}

/**
 * Outgoing POST body sent to the LangGraph endpoint.
 */
export interface LangGraphRequestBody {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  threadId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SSE parser (framework-free)
// ---------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const evt: SseEvent = {
      event: eventName || 'message',
      data: dataLines.join('\n'),
    };
    eventName = '';
    dataLines = [];
    return evt;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      buffer = buffer.replace(/\r\n?/g, '\n');

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (line === '') {
          const evt = flush();
          if (evt) yield evt;
          continue;
        }

        if (line.startsWith(':')) continue;

        const colonIdx = line.indexOf(':');
        let field: string;
        let value: string;
        if (colonIdx === -1) {
          field = line;
          value = '';
        } else {
          field = line.slice(0, colonIdx);
          value = line.slice(colonIdx + 1);
          if (value.startsWith(' ')) value = value.slice(1);
        }

        if (field === 'event') {
          eventName = value;
        } else if (field === 'data') {
          dataLines.push(value);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const tail = buffer;
      buffer = '';
      if (!tail.startsWith(':')) {
        const colonIdx = tail.indexOf(':');
        if (colonIdx !== -1) {
          const field = tail.slice(0, colonIdx);
          let value = tail.slice(colonIdx + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
      }
    }
    const finalEvt = flush();
    if (finalEvt) yield finalEvt;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Transport hook
// ---------------------------------------------------------------------------

export interface UseLangGraphChatTransportOptions extends ChatTransportConfig {
  threadId?: string;
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
  credentials?: RequestCredentials;
  onCustomEvent?: (evt: LangGraphCustomEvent) => ChatTransportDataPart | null;
  renderUpdate?: (node: string, update: Record<string, unknown>) => string | null;
}

function defaultRenderUpdate(node: string): string | null {
  return `${node} running…`;
}

function emptyAssistantMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [],
    createdAt: new Date(),
  };
}

function appendTextDelta(message: ChatMessage, delta: string): ChatMessage {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last && last.type === 'text') {
    const updated: TextPart = { type: 'text', text: last.text + delta };
    parts[parts.length - 1] = updated;
  } else {
    parts.push({ type: 'text', text: delta });
  }
  return { ...message, parts };
}

function appendPart(message: ChatMessage, part: MessagePart): ChatMessage {
  return { ...message, parts: [...message.parts, part] };
}

function upsertToolInvocation(
  message: ChatMessage,
  evt: LangGraphToolCallEvent,
): ChatMessage {
  const existing = message.parts.findIndex(
    (p) => p.type === 'tool-invocation' && (p as ToolInvocationPart).toolInvocationId === evt.id,
  );
  const invocation: ToolInvocationPart = {
    type: 'tool-invocation',
    toolInvocationId: evt.id,
    toolName: evt.name,
    args: evt.args ?? {},
    state: 'call',
  };
  if (existing === -1) return appendPart(message, invocation);
  const parts = [...message.parts];
  parts[existing] = invocation;
  return { ...message, parts };
}

function applyToolResult(
  message: ChatMessage,
  evt: LangGraphToolResultEvent,
): ChatMessage {
  const parts = [...message.parts];
  const idx = parts.findIndex(
    (p) => p.type === 'tool-invocation' && (p as ToolInvocationPart).toolInvocationId === evt.id,
  );
  if (idx !== -1) {
    const invocation = parts[idx] as ToolInvocationPart;
    parts[idx] = { ...invocation, state: 'output-available', result: evt.result };
  }
  const result: ToolResultPart = {
    type: 'tool-result',
    toolInvocationId: evt.id,
    toolName: (parts[idx] as ToolInvocationPart | undefined)?.toolName ?? 'unknown',
    result: evt.result,
  };
  parts.push(result);
  return { ...message, parts };
}

function toWireMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join(''),
  }));
}

function resolveHeaders(
  headers: ChatTransportConfig['headers'],
): Record<string, string> {
  if (!headers) return {};
  return typeof headers === 'function' ? headers() : headers;
}

function resolveBodyExtras(
  extras: UseLangGraphChatTransportOptions['bodyExtras'],
): Record<string, unknown> {
  if (!extras) return {};
  return typeof extras === 'function' ? extras() : extras;
}

export function useLangGraphChatTransport(
  options: UseLangGraphChatTransportOptions,
): ChatTransport {
  const {
    endpoint,
    headers,
    onData,
    threadId,
    bodyExtras,
    credentials = 'same-origin',
    onCustomEvent,
    renderUpdate = defaultRenderUpdate,
  } = options;

  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatTransport['status']>('ready');
  const [error, setError] = useState<Error | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const statusLabelRef = useRef<string | null>(null);
  // Mirror of the latest messages list. Used by `sendMessage` to compute
  // the wire history *synchronously*, before the React state update
  // has been committed — passing the result through a function updater
  // ran into batching/timing where the closure captured the pre-update
  // value and we shipped `messages: []` to the backend.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const headersRef = useRef(headers);
  headersRef.current = headers;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const bodyExtrasRef = useRef(bodyExtras);
  bodyExtrasRef.current = bodyExtras;
  // Thread id is stored in a ref so session switches picked up by the
  // provider propagate into the next sendMessage without re-binding it.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const subscribersRef = useRef<Set<ChatTransportDataHandler>>(new Set());
  const subscribeToData = useCallback((handler: ChatTransportDataHandler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);
  const emitData = useCallback((part: ChatTransportDataPart) => {
    onDataRef.current?.(part);
    subscribersRef.current.forEach((fn) => fn(part));
  }, []);
  const onCustomEventRef = useRef(onCustomEvent);
  onCustomEventRef.current = onCustomEvent;
  const renderUpdateRef = useRef(renderUpdate);
  renderUpdateRef.current = renderUpdate;

  const setMessages = useCallback((next: ChatMessage[]) => {
    setMessagesState(next);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus((prev) => (prev === 'streaming' || prev === 'submitted' ? 'ready' : prev));
  }, []);

  const sendMessage = useCallback(
    async ({ text }: { text: string }) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setStatus('submitted');
      statusLabelRef.current = null;

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt: new Date(),
      };
      const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const assistantPlaceholder = emptyAssistantMessage(assistantId);

      // Compute the request payload from the synchronous mirror so we
      // don't depend on React having committed the state update yet.
      const previousMessages = messagesRef.current;
      const historyForRequest: ChatMessage[] = [...previousMessages, userMessage];
      const nextMessages: ChatMessage[] = [
        ...previousMessages,
        userMessage,
        assistantPlaceholder,
      ];
      messagesRef.current = nextMessages;
      setMessagesState(nextMessages);

      const updateAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
        setMessagesState((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = updater(prev[idx]);
          return next;
        });
      };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          credentials,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...resolveHeaders(headersRef.current),
          },
          body: JSON.stringify({
            messages: toWireMessages(historyForRequest),
            ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
            ...resolveBodyExtras(bodyExtrasRef.current),
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(
            `LangGraph transport: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
          );
        }

        setStatus('streaming');
        let sawDone = false;

        for await (const evt of parseSseStream(res.body)) {
          switch (evt.event) {
            case 'message': {
              const data = JSON.parse(evt.data) as LangGraphMessageEvent;
              if (typeof data.content === 'string' && data.content.length > 0) {
                updateAssistant((m) => appendTextDelta(m, data.content));
              }
              break;
            }
            case 'updates': {
              const data = JSON.parse(evt.data) as LangGraphUpdatesEvent;
              const label = renderUpdateRef.current?.(data.node, data.update ?? {});
              if (label) {
                statusLabelRef.current = label;
                emitData({
                  type: 'data-langgraph-update',
                  data: { node: data.node, update: data.update, label },
                });
              }
              break;
            }
            case 'custom': {
              const data = JSON.parse(evt.data) as LangGraphCustomEvent;
              const forwarded = onCustomEventRef.current?.(data);
              if (forwarded) {
                emitData(forwarded);
              }
              break;
            }
            case 'tool_call': {
              const data = JSON.parse(evt.data) as LangGraphToolCallEvent;
              updateAssistant((m) => upsertToolInvocation(m, data));
              break;
            }
            case 'tool_result': {
              const data = JSON.parse(evt.data) as LangGraphToolResultEvent;
              updateAssistant((m) => applyToolResult(m, data));
              break;
            }
            case 'error': {
              const data = JSON.parse(evt.data) as LangGraphErrorEvent;
              throw new Error(data.message || 'LangGraph stream error');
            }
            case 'done': {
              sawDone = true;
              break;
            }
            default:
              break;
          }
          if (sawDone) break;
        }

        if (!sawDone) {
          throw new Error('LangGraph transport: stream closed without `done` event');
        }

        setStatus('ready');
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setStatus('ready');
          return;
        }
        setError(err as Error);
        setStatus('error');
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [endpoint, credentials, threadId, emitData],
  );

  const addToolApprovalResponse = useCallback(
    async (_response: ChatTransportApprovalResponse) => {
      // LangGraph's approval story is consumer-driven: the backend decides
      // how to resume from an interrupted graph. No-op here.
    },
    [],
  );

  return useMemo<ChatTransport>(
    () => ({
      messages,
      status,
      error,
      sendMessage,
      stop,
      setMessages,
      addToolApprovalResponse,
      subscribeToData,
    }),
    [messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse, subscribeToData],
  );
}
