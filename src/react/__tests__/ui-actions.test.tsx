// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import type { ChatTransport } from '../types.js';
import {
  dispatchAiClientAction,
  getDefaultUiActionBus,
  UiActionBus,
  useAiClientAction,
  useGlirastesNavigationBridge,
} from '../index.js';

afterEach(cleanup);

const highlight = z.object({ taskId: z.string() }).strict();

function Highlighter({ onHighlight }: { onHighlight: (taskId: string) => void }) {
  useAiClientAction('tasks.highlight', (payload) => onHighlight(payload.taskId), highlight);
  return null;
}

function Bridge({ push, bus }: { push: (href: string) => void; bus?: UiActionBus }) {
  useGlirastesNavigationBridge({ push, ...(bus ? { bus } : {}) });
  return null;
}

describe('useAiClientAction with a contract', () => {
  it('runs generated client actions from the default bus with a validated payload', async () => {
    const onHighlight = vi.fn();
    const view = render(<Highlighter onHighlight={onHighlight} />);
    const bus = getDefaultUiActionBus();

    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    await expect(bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: 2 } }))
      .rejects.toThrow('Invalid payload');
    expect(onHighlight).toHaveBeenCalledTimes(1);
    expect(onHighlight).toHaveBeenCalledWith('2');

    view.unmount();
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '3' } });
    expect(onHighlight).toHaveBeenCalledTimes(1);
  });

  it('keeps the window-event channel for existing callers and validates it too', () => {
    const onHighlight = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Highlighter onHighlight={onHighlight} />);
    dispatchAiClientAction({ actionId: 'tasks.highlight', payload: { taskId: '5' } });
    dispatchAiClientAction({ actionId: 'tasks.highlight', payload: { taskId: 5 } });
    expect(onHighlight).toHaveBeenCalledTimes(1);
    expect(onHighlight).toHaveBeenCalledWith('5');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('useGlirastesNavigationBridge', () => {
  it('pushes navigation results with the latest router and stops on unmount', async () => {
    const bus = new UiActionBus();
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Bridge push={first} bus={bus} />);
    view.rerender(<Bridge push={second} bus={bus} />);
    await bus.dispatch({ type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/overview' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('/overview');

    view.unmount();
    await bus.dispatch({ type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks' } });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('AiChatProvider and generated UI actions', () => {
  function transport(output: unknown): ChatTransport {
    return {
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'tool-ui_navigate', toolCallId: 'call-1', state: 'output-available', output } as never],
      }],
      status: 'ready',
      error: null,
      sendMessage: vi.fn(async () => {}),
      stop: vi.fn(),
      setMessages: vi.fn(),
      addToolApprovalResponse: vi.fn(async () => {}),
    };
  }

  it('hands a generated navigation result to the bus after onToolResult', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    const onToolResult = vi.fn();
    render(
      <AiChatProvider
        transport={transport({
          success: true,
          message: 'Action executed.',
          uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks?status=done' } },
        })}
        uiActionBus={bus}
        onToolResult={onToolResult}
      >
        <Bridge push={push} bus={bus} />
      </AiChatProvider>,
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tasks?status=done'));
    expect(onToolResult).toHaveBeenCalledWith('ui_navigate', expect.objectContaining({ success: true }));
  });

  it('records false as rejection, preserves feedback across streamed updates, and never replays the call', async () => {
    const bus = new UiActionBus();
    const handler = vi.fn(() => false);
    const { registerAiClientAction } = await import('../../browser/client-actions.js');
    registerAiClientAction('tasks.highlight', handler, undefined, { bus });
    const output = { success: true, requested: true, executionStatus: 'unconfirmed', uiAction: {
      type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: 'job_003' },
    } };
    const t = transport(output);
    const view = render(<AiChatProvider transport={t} uiActionBus={bus}><div /></AiChatProvider>);
    await waitFor(() => expect(t.setMessages).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ parts: expect.arrayContaining([expect.objectContaining({
        type: 'data-ui-action-status', data: { toolCallId: 'call-1', status: 'rejected' },
      })]) }),
    ])));
    const streamed = { ...t, messages: t.messages.map((message) => ({ ...message, parts: [...message.parts, { type: 'text' as const, text: 'Requested.' }] })) };
    view.rerender(<AiChatProvider transport={streamed} uiActionBus={bus}><div /></AiChatProvider>);
    await waitFor(() => expect(t.setMessages).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cancels route-bound work after unmount before the page registers', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    bus.subscribeById('glirastes.navigate', push);
    const handler = vi.fn();
    const t = transport({ success: true, uiAction: { type: 'glirastes.action', actionId: 'tasks.highlight', route: '/tasks' } });
    const view = render(<AiChatProvider transport={t} uiActionBus={bus}><div /></AiChatProvider>);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    view.unmount();
    bus.subscribeById('tasks.highlight', handler);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves app-specific uiActions to the app', async () => {
    const bus = new UiActionBus();
    const seen = vi.fn();
    bus.subscribeByType('set-filters', seen);
    render(
      <AiChatProvider transport={transport({ success: true, uiAction: { type: 'set-filters', filters: {} } })} uiActionBus={bus}>
        <div />
      </AiChatProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).not.toHaveBeenCalled();
  });
});
