// @vitest-environment jsdom

import React, { useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  GLIRASTES_NAVIGATE_ACTION_ID,
  registerAiClientAction,
  registerDocumentNavigation,
  registerNavigationBridge,
  UiActionBus,
} from '../../../browser/index.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, SessionConfig, UiActionOutcomeEvent } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

type Status = ChatTransport['status'];

interface Control {
  set(messages: ChatMessage[], status?: Status): void;
  status(status: Status): void;
  clear(): void;
}

let control: Control;
let warn: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

function ClearButton() {
  const { clear } = useChatContext();
  control.clear = clear;
  return null;
}

function Host({ initial = [], initialStatus = 'ready', config }: {
  initial?: ChatMessage[];
  initialStatus?: Status;
  config: AiChatProviderConfig & { session?: SessionConfig };
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [status, setStatus] = useState<Status>(initialStatus);
  control = {
    set: (next, nextStatus) => {
      setMessages(next);
      if (nextStatus) setStatus(nextStatus);
    },
    status: setStatus,
    clear: () => {},
  };
  const transport = useMemo<ChatTransport>(() => ({
    messages,
    status,
    error: null,
    sendMessage: async () => {},
    stop: () => {},
    // Stable like a real transport's setter.
    setMessages,
    addToolApprovalResponse: () => {},
  }), [messages, status]);
  return (
    <AiChatProvider transport={transport} {...config}>
      <ClearButton />
    </AiChatProvider>
  );
}

const user: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Öffne die Aufgaben' }] } as ChatMessage;

function toolPart(toolCallId: string, uiAction: unknown, state = 'output-available', extra: Record<string, unknown> = {}) {
  return {
    type: 'tool-ui_navigate',
    toolCallId,
    state,
    input: {},
    ...(state === 'output-available'
      ? { output: { success: true, message: 'Handed to the app.', uiAction, ...extra } }
      : {}),
  };
}

function assistant(...parts: unknown[]): ChatMessage {
  return { id: 'a1', role: 'assistant', parts } as unknown as ChatMessage;
}

const navigate = (href = '/tasks') => ({ type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href } });
const action = (actionId: string, payload: unknown = {}) => ({ type: 'glirastes.action', actionId, payload });

async function stream(...messages: ChatMessage[][]) {
  await act(async () => { control.set([user], 'submitted'); });
  for (const next of messages) {
    await act(async () => { control.set(next, 'streaming'); });
  }
  await act(async () => { control.status('ready'); });
}

function setup(config: AiChatProviderConfig = {}, initial?: ChatMessage[]) {
  const bus = new UiActionBus();
  const outcomes: UiActionOutcomeEvent[] = [];
  const onToolResult = vi.fn();
  render(
    <Host
      initial={initial}
      config={{
        uiActionBus: bus,
        onToolResult,
        onUiActionOutcome: (event) => { outcomes.push(event); },
        ...config,
      }}
    />,
  );
  return { bus, outcomes, onToolResult };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

describe('AiChatProvider UI action outcomes', () => {
  it('runs a streamed navigation (Next router, push returns void) and reports ok', async () => {
    const { bus, outcomes, onToolResult } = setup();
    const push = vi.fn(() => undefined);
    cleanups.push(registerNavigationBridge({ bus, push }));
    await stream(
      [user, assistant(toolPart('call-1', undefined, 'input-available'))],
      [user, assistant(toolPart('call-1', navigate('/tasks?status=done')))],
    );
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(push).toHaveBeenCalledWith('/tasks?status=done');
    expect(onToolResult).toHaveBeenCalledWith('ui_navigate', expect.objectContaining({ success: true }));
    expect(outcomes[0]).toEqual({
      toolName: 'ui_navigate',
      toolCallId: 'call-1',
      code: 'ok',
      actions: [{ type: 'glirastes.navigate', actionId: 'glirastes.navigate' }],
      reported: false,
      durationMs: expect.any(Number),
    });
    expect(Object.keys(outcomes[0]!)).not.toContain('payload');
  });

  it('runs a result that arrives in the same render that ends the stream', async () => {
    const { bus, outcomes } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await act(async () => { control.set([user], 'submitted'); });
    await act(async () => { control.set([user, assistant(toolPart('call-1', navigate()))], 'ready'); });
    await waitFor(() => expect(outcomes.map((event) => event.code)).toEqual(['ok']));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable for an app without client routing (no bridge)', async () => {
    const { outcomes } = setup();
    await stream([user, assistant(toolPart('call-1', navigate()))]);
    await waitFor(() => expect(outcomes.map((event) => event.code)).toEqual(['unavailable']));
  });

  it('fires the hook for every code, one tool result after another', async () => {
    const { bus, outcomes } = setup({ uiActionOutcomeTimeoutMs: 30 });
    const boom = new Error('boom');
    cleanups.push(registerNavigationBridge({ bus, push: async () => false }));
    cleanups.push(registerAiClientAction('tasks.highlight', () => {}, z.object({ taskId: z.string() }), { bus }));
    cleanups.push(registerAiClientAction('dialogs.open', () => true, undefined, { bus }));
    cleanups.push(registerAiClientAction('dialogs.crash', () => { throw boom; }, undefined, { bus }));
    cleanups.push(bus.subscribeById('dialogs.hang', () => new Promise<void>(() => {})));
    await stream([user, assistant(
      toolPart('c-ok', action('dialogs.open')),
      toolPart('c-contract', action('tasks.highlight', { taskId: 1 })),
      toolPart('c-handler', navigate()),
      toolPart('c-failed', action('dialogs.crash')),
      toolPart('c-unavailable', action('nobody.home')),
      toolPart('c-timeout', action('dialogs.hang')),
    )]);
    await waitFor(() => expect(outcomes).toHaveLength(6));
    expect(outcomes.map((event) => [event.toolCallId, event.code])).toEqual([
      ['c-ok', 'ok'],
      ['c-contract', 'rejected-contract'],
      ['c-handler', 'rejected-handler'],
      ['c-failed', 'failed'],
      ['c-unavailable', 'unavailable'],
      ['c-timeout', 'timeout'],
    ]);
    expect(outcomes[3]!.error).toBe(boom);
  });

  it('runs tool results sequentially in call order; a failed first call does not stop the second', async () => {
    const { bus, outcomes } = setup();
    const order: string[] = [];
    cleanups.push(bus.subscribeById('slow.first', async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first:end');
      throw new Error('first failed');
    }));
    cleanups.push(bus.subscribeById('second', () => { order.push('second'); }));
    await stream([user, assistant(toolPart('c1', action('slow.first')), toolPart('c2', action('second')))]);
    await waitFor(() => expect(outcomes).toHaveLength(2));
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(outcomes.map((event) => event.code)).toEqual(['failed', 'ok']);
  });

  it('reports initiated for a reloading navigation and runs no later tool result on the page', async () => {
    const { bus, outcomes } = setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const later = vi.fn();
    cleanups.push(registerDocumentNavigation({ bus }));
    cleanups.push(bus.subscribeById('toast.show', later));
    await stream([user, assistant(toolPart('c1', navigate('/reports')), toolPart('c2', action('toast.show')))]);
    await waitFor(() => expect(outcomes.map((event) => event.code)).toEqual(['initiated']));
    await settle();
    expect(assign).toHaveBeenCalledWith('/reports');
    expect(later).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
  });

  it('catches a throwing hook and keeps running later results', async () => {
    const bus = new UiActionBus();
    const seen = vi.fn();
    cleanups.push(bus.subscribeById('a', seen));
    cleanups.push(bus.subscribeById('b', seen));
    render(<Host config={{ uiActionBus: bus, onUiActionOutcome: () => { throw new Error('hook'); } }} />);
    await stream([user, assistant(toolPart('c1', action('a')), toolPart('c2', action('b')))]);
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
  });

  it('leaves hand-written UI tools to onToolResult without an outcome', async () => {
    const { bus, outcomes, onToolResult } = setup();
    const appHandler = vi.fn();
    cleanups.push(bus.subscribeByType('set-filters', appHandler));
    await stream([user, assistant(toolPart('c1', { type: 'set-filters', filters: { status: 'done' } }))]);
    await waitFor(() => expect(onToolResult).toHaveBeenCalledTimes(1));
    await settle();
    expect(appHandler).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('runs an approved UI tool whose call was shown before the continuation started', async () => {
    const { bus, outcomes } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await stream([user, assistant({ ...toolPart('c1', undefined, 'approval-requested'), approval: { id: 'ap-1' } })]);
    await act(async () => {
      control.set([user, assistant({ ...toolPart('c1', undefined, 'approval-responded'), approval: { id: 'ap-1', approved: true } })]);
    });
    await stream([user, assistant(toolPart('c1', navigate()))]);
    await waitFor(() => expect(outcomes.map((event) => event.code)).toEqual(['ok']));
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('AiChatProvider never runs a UI action late', () => {
  const stored = () => [user, assistant(toolPart('old-1', navigate('/old')))];

  it('does not run results of messages a custom transport starts with', async () => {
    const { bus, outcomes, onToolResult } = setup({}, stored());
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await settle();
    expect(push).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('does not run results of a history the host sets, before or after a request', async () => {
    const { bus, outcomes, onToolResult } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await act(async () => { control.set(stored()); });
    await settle();
    expect(push).not.toHaveBeenCalled();

    await stream([user, assistant(toolPart('live-1', navigate('/live')))]);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/live'));
    // Live sync of a second tab, or the host restoring another history afterwards.
    await act(async () => {
      control.set([user, { ...assistant(toolPart('synced-1', navigate('/synced'))), id: 'a2' } as ChatMessage]);
    });
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
  });

  it('does not run results loaded through session.load', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    const session: SessionConfig = { load: async () => stored(), save: async () => {} };
    render(<Host config={{ uiActionBus: bus, session }} />);
    await settle();
    expect(push).not.toHaveBeenCalled();
  });

  it('never runs a result that already carries an outcome, even while streaming', async () => {
    const { bus, outcomes, onToolResult } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await stream([user, assistant(toolPart('c1', navigate(), 'output-available', { outcome: { v: 1, code: 'ok' } }))]);
    await settle();
    expect(push).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('does not run results that come back after clear()', async () => {
    const { bus } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await stream([user, assistant(toolPart('c1', navigate('/once')))]);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await act(async () => { control.clear(); });
    await act(async () => { control.set(stored()); });
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });
});
