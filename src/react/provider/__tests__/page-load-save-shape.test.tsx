// @vitest-environment jsdom

import React, { useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLIRASTES_NAVIGATE_ACTION_ID,
  registerDocumentNavigation,
  registerNavigationBridge,
  UiActionBus,
} from '../../../browser/index.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, SessionConfig, UiActionOutcomeEvent } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';

/**
 * `session.save` is written from two places: the save on every change and the
 * save right before a UI action loads another page (a reloading bridge, or
 * `pagehide`). Both must write the same shape: the held stopped tool-step
 * message at its place and every recorded turn outcome on its user message.
 * The queue's own store (`queue.storage`) holds queued items, not the history.
 */

type Status = ChatTransport['status'];
type ToolOutput = { tool: string; toolCallId: string; output: Record<string, unknown> };

let control: {
  set(messages: ChatMessage[], status?: Status): void;
  status(status: Status): void;
  messages(): ChatMessage[];
};
let warn: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

/** A transport like the bundled one: `addToolOutput` replaces the output in the last message. */
function Host({ config }: { config: AiChatProviderConfig & { session?: SessionConfig } }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>('ready');
  control = {
    set: (next, nextStatus) => {
      setMessages(next);
      if (nextStatus) setStatus(nextStatus);
    },
    status: setStatus,
    messages: () => messages,
  };
  const transport = useMemo<ChatTransport>(() => ({
    messages,
    status,
    error: null,
    sendMessage: async () => {},
    stop: () => {},
    setMessages,
    addToolApprovalResponse: () => {},
    addToolOutput: async (value: ToolOutput) => {
      setMessages((current) => current.map((message, index) => (index !== current.length - 1 ? message : {
        ...message,
        parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === value.toolCallId
          ? { ...part, output: value.output }
          : part)),
      }) as ChatMessage));
    },
    continueTurn: () => {},
    setUiOutcomeReporting: () => {},
  }), [messages, status]);
  return <AiChatProvider transport={transport} {...config} />;
}

const outcomeOf = (status: string) => ({ glirastesTurnOutcome: { status, reason: status === 'error' ? 'request-failed' : 'stopped', at: 'x' } });
const userMessage = (id: string, text: string, metadata?: unknown) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) }) as unknown as ChatMessage;
// A turn stopped during a tool call: held out of the transport, shown and stored.
const stoppedToolTurn = (id: string) => ({ id, role: 'assistant', parts: [{ type: 'step-start' },
  { type: 'tool-tasks_list', toolCallId: `${id}-t`, state: 'input-available', input: {} }] } as unknown as ChatMessage);
const user = userMessage('u1', 'Open the tasks');
const navigate = (href = '/tasks') => ({ type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href } });
const uiPart = (toolCallId: string, href?: string) => ({
  type: 'tool-ui_navigate', toolCallId, state: 'output-available', input: {},
  output: { handedOff: true, message: 'Handed to the app.', uiAction: navigate(href), awaitsOutcome: true },
});
const assistant = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] } as unknown as ChatMessage);
const storedOutcome = (messages: ChatMessage[], id: string) =>
  (messages.find((m) => m.id === id) as { metadata?: Record<string, unknown> } | undefined)?.metadata?.glirastesTurnOutcome;
const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** The earlier chat A: a stopped turn (outcome stored) whose message is held out of the transport. */
const historyA = () => [userMessage('u0', 'earlier', outcomeOf('aborted')), stoppedToolTurn('a0')];

describe('every save of the history has the same shape', () => {
  it('the save right before location.assign keeps the earlier outcome and the held stopped tool turn', async () => {
    const order: string[] = [];
    const saves: ChatMessage[][] = [];
    const session: SessionConfig = { load: async () => historyA(), save: async (_id, messages) => { order.push('save'); saves.push(messages); } };
    const bus = new UiActionBus();
    const outcomes: UiActionOutcomeEvent[] = [];
    render(<Host config={{ session, uiActionBus: bus, onUiActionOutcome: (event) => { outcomes.push(event); } }} />);
    vi.stubGlobal('location', { assign: vi.fn(() => { order.push('assign'); }) });
    cleanups.push(registerDocumentNavigation({ bus }));
    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.at(-1)!.map((m) => m.id)).toEqual(['u0', 'a0']);
    const base = control.messages();
    expect(base.map((m) => m.id)).toEqual(['u0']);
    order.length = 0;
    saves.length = 0;
    await act(async () => { control.set([...base, user], 'submitted'); });
    await act(async () => { control.set([...base, user, assistant(uiPart('c1', '/reports'))], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await waitFor(() => expect(outcomes).toHaveLength(1));
    const savesBeforeAssign = order.slice(0, order.indexOf('assign')).filter((entry) => entry === 'save').length;
    expect(savesBeforeAssign).toBeGreaterThan(0);
    const saved = saves[savesBeforeAssign - 1]!;
    expect({ ids: saved.map((m) => m.id), outcome: storedOutcome(saved, 'u0') ?? null })
      .toEqual({ ids: ['u0', 'a0', 'u1', 'a1'], outcome: expect.objectContaining({ status: 'aborted' }) });
  });

  it('on every path: a change, the pagehide save, a session switch; unmount writes nothing', async () => {
    const histories: Record<string, ChatMessage[]> = {
      A: historyA(),
      B: [userMessage('bu0', 'other', outcomeOf('error'))],
    };
    const saves: Array<{ id: string; path: string; messages: ChatMessage[] }> = [];
    let path = 'change';
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id) => histories[id] ?? [],
      save: async (id, messages) => { saves.push({ id, path, messages }); },
    });
    const bus = new UiActionBus();
    const view = render(<Host config={{ session: session('A'), uiActionBus: bus }} />);
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}) }));
    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const base = control.messages();
    await act(async () => { control.set([...base, user], 'submitted'); });
    await act(async () => { control.set([...base, user, assistant(uiPart('c1'))], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await settle();
    path = 'pagehide';
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await settle();
    path = 'switch';
    view.rerender(<Host config={{ session: session('B'), uiActionBus: bus }} />);
    await waitFor(() => expect(saves.some((entry) => entry.id === 'B')).toBe(true));
    path = 'unmount';
    view.unmount();
    await settle();

    expect([...new Set(saves.map((entry) => entry.path))]).toEqual(['change', 'pagehide', 'switch']);
    expect(saves.filter((entry) => entry.path === 'unmount')).toEqual([]);
    for (const entry of saves.filter((candidate) => candidate.id === 'A')) {
      expect({ path: entry.path, ids: entry.messages.map((m) => m.id).slice(0, 2), outcome: storedOutcome(entry.messages, 'u0') })
        .toEqual({ path: entry.path, ids: ['u0', 'a0'], outcome: expect.objectContaining({ status: 'aborted' }) });
    }
    for (const entry of saves.filter((candidate) => candidate.id === 'B')) {
      expect(storedOutcome(entry.messages, 'bu0')).toEqual(expect.objectContaining({ status: 'error' }));
    }
  });
});
