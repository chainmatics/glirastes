import React, { useEffect, useReducer } from 'react';
import { vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  ChatTransportDataHandler,
} from '../types.js';

/**
 * A transport that behaves like the AI SDK's `useChat` on a stop: the assistant
 * message streamed so far stays in the history; `stop()` only ends the request.
 */
export class StreamingChat {
  messages: ChatMessage[] = [];
  status: ChatTransport['status'] = 'ready';
  sent: string[] = [];
  /** The history each send hands to the backend (the transport's messages with the new one), as `useChat` sends it. */
  requests: ChatMessage[][] = [];
  error: Error | null = null;
  private listeners = new Set<() => void>();
  private dataHandlers = new Set<ChatTransportDataHandler>();
  private pending: Array<() => void> = [];
  // Unique across instances, as the AI SDK's ids are: a reloaded chat never reuses a stored id.
  private static ids = 0;
  private get nextId() { StreamingChat.ids += 1; return StreamingChat.ids; }
  private streamingId: string | null = null;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  sendMessage = vi.fn(({ text }: { text: string }) => {
    this.sent.push(text);
    this.messages = [...this.messages, { id: `u${this.nextId}`, role: 'user', parts: [{ type: 'text', text }] }];
    this.requests.push(this.messages);
    this.status = 'submitted';
    this.error = null;
    this.streamingId = null;
    this.notify();
    return new Promise<void>((resolve) => { this.pending.push(resolve); });
  });

  /** The assistant message of the running request, as streamed so far. */
  stream(parts: unknown[]) {
    if (!this.streamingId) {
      this.streamingId = `a${this.nextId}`;
      this.messages = [...this.messages, { id: this.streamingId, role: 'assistant', parts: parts as ChatMessage['parts'] }];
    } else {
      const id = this.streamingId;
      this.messages = this.messages.map((message) => (
        message.id === id ? { ...message, parts: parts as ChatMessage['parts'] } : message
      ));
    }
    this.status = 'streaming';
    this.notify();
  }

  stop = vi.fn(() => {
    this.status = 'ready';
    this.streamingId = null;
    this.settle();
    this.notify();
  });

  finish(parts: unknown[] = [{ type: 'text', text: 'done' }]) {
    this.stream(parts);
    this.status = 'ready';
    this.streamingId = null;
    this.settle();
    this.notify();
  }

  /** Ends the running request with a transport error (e.g. the network before the first token). */
  fail(error = new Error('network')) {
    this.status = 'error';
    this.error = error;
    this.streamingId = null;
    this.settle();
    this.notify();
  }

  /** A new attempt of the latest user message without a new one (AI SDK `regenerate`). */
  retry() {
    const lastUser = this.messages.map((message) => message.role).lastIndexOf('user');
    this.messages = this.messages.slice(0, lastUser + 1);
    this.status = 'submitted';
    this.error = null;
    this.streamingId = null;
    this.notify();
  }

  /** A new request that continues the history as it is (the AI SDK's request after an approval answer). */
  resume() {
    this.status = 'submitted';
    this.error = null;
    this.streamingId = null;
    this.notify();
  }

  setMessages = vi.fn((messages: ChatMessage[]) => {
    this.messages = messages;
    this.notify();
  });

  addToolApprovalResponse = vi.fn(async (_response: { id: string; approved: boolean; reason?: string }) => {});

  subscribeToData = (handler: ChatTransportDataHandler) => {
    this.dataHandlers.add(handler);
    return () => { this.dataHandlers.delete(handler); };
  };

  /** A data part of the running request (`data-pipeline-state`, ...). */
  emit(part: { type: string; data: unknown }) {
    for (const handler of this.dataHandlers) handler(part);
  }

  private settle() {
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) resolve();
  }

  get transport(): ChatTransport {
    return {
      messages: this.messages,
      status: this.status,
      error: this.error,
      sendMessage: this.sendMessage,
      stop: this.stop,
      setMessages: this.setMessages,
      addToolApprovalResponse: this.addToolApprovalResponse,
      subscribeToData: this.subscribeToData,
    };
  }
}

export let ctx: ChatContextValue;
export function Probe() {
  ctx = useChatContext();
  return null;
}

export function Host({ chat, config }: { chat: StreamingChat; config?: Partial<AiChatProviderConfig> }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

export interface RenderedTurn {
  text: string;
  steps: string[];
  notice: string | null;
}

/** What every assistant bubble shows: its text, the status of each logged step, and a stop notice. */
export function renderedTurns(): RenderedTurn[] {
  return [...document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')].map((bubble) => {
    const notice = bubble.querySelector('[data-element="activity-notice"], [data-component="turn-notice"]');
    return {
      text: [...bubble.querySelectorAll('[data-component="markdown"]')].map((node) => node.textContent ?? '').join(''),
      steps: [...bubble.querySelectorAll('[data-element="activity-step"]')].map((step) => step.getAttribute('data-status') ?? ''),
      notice: notice?.textContent ?? null,
    };
  });
}

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
  };
}

