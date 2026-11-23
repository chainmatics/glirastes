// @vitest-environment jsdom

import React, { useEffect, useMemo, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { MessageList } from '../message-list.js';
import type { ChatMessage, ChatTransport } from '../../types.js';

afterEach(() => {
  cleanup();
});

const user = (id: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'Go' }] } as ChatMessage);
const assistant = (id: string, ...parts: unknown[]): ChatMessage => ({ id, role: 'assistant', parts } as ChatMessage);
const running = (id: string, tool = 'tasks_list') => ({ type: `tool-${tool}`, toolCallId: id, state: 'input-available', input: {} });
const finished = (id: string, tool = 'tasks_list') => ({ type: `tool-${tool}`, toolCallId: id, state: 'output-available', input: {}, output: { success: true } });
const step = { type: 'step-start' };
const text = (value: string) => ({ type: 'text', text: value, state: 'done' });

function Harness({ status, messages, sections }: { status: ChatTransport['status']; messages: ChatMessage[]; sections?: boolean }) {
  const [current, setCurrent] = useState(messages);
  useEffect(() => setCurrent(messages), [messages]);
  const transport = useMemo<ChatTransport>(() => ({
    messages: current,
    status,
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: () => {},
    setMessages: (next) => setCurrent(next),
    addToolApprovalResponse: vi.fn(async () => {}),
  }), [current, status]);
  return (
    <AiChatProvider
      transport={transport}
      locale={{}}
      activityLog={{ expandWhileRunning: true, ...(sections ? { grouping: 'sections' as const } : {}) }}
    >
      <MessageList />
    </AiChatProvider>
  );
}

const logs = () => Array.from(document.querySelectorAll('[data-component="activity-log"]')) as HTMLDetailsElement[];
/** Fires the `toggle` a browser queues after React set `open`, as jsdom does not. */
async function settleToggles() {
  await act(async () => {
    for (const log of logs()) log.dispatchEvent(new Event('toggle'));
  });
}

describe('activityLog.expandWhileRunning with several steps', () => {
  it('keeps the log open through consecutive tool steps and closes it once the turn is over', async () => {
    const history = [user('u1')];
    const frames = [
      [assistant('a1', step, running('c1'))],
      [assistant('a1', step, finished('c1'), step, running('c2', 'tasks_get'))],
      [assistant('a1', step, finished('c1'), step, finished('c2', 'tasks_get'), step, running('c3', 'tasks_update'))],
      [assistant('a1', step, finished('c1'), step, finished('c2', 'tasks_get'), step, finished('c3', 'tasks_update'))],
    ];
    const view = render(<Harness status="streaming" messages={[...history, ...frames[0]!]} />);
    for (const frame of frames) {
      view.rerender(<Harness status="streaming" messages={[...history, ...frame]} />);
      await settleToggles();
      expect(logs().map((log) => log.open)).toEqual([true]);
    }
    view.rerender(<Harness status="ready" messages={[...history, ...frames.at(-1)!]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([false]);
  });

  it('keeps the log open with parallel calls of one step', async () => {
    const history = [user('u1')];
    const view = render(<Harness status="streaming" messages={[...history, assistant('a1', step, running('c1'), running('c2'), running('c3'))]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([true]);
    view.rerender(<Harness status="streaming" messages={[...history, assistant('a1', step, finished('c1'), running('c2'), finished('c3'))]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([true]);
  });

  it('opens the log of the turn that runs, also after earlier turns in the same chat', async () => {
    const earlier = [user('u0'), assistant('a0', step, finished('c0'), text('Done.'))];
    const view = render(<Harness status="ready" messages={earlier} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([false]);
    view.rerender(<Harness status="streaming" messages={[...earlier, user('u1'), assistant('a1', step, running('c1'), running('c2'))]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([false, true]);
  });

  it("with grouping 'sections' opens every section that has a running call and the last one", async () => {
    const history = [user('u1')];
    const view = render(<Harness sections status="streaming" messages={[...history, assistant('a1', step, running('c1'))]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([true]);
    view.rerender(<Harness sections status="streaming" messages={[...history, assistant('a1', step, finished('c1'), text('Now the details.'), step, running('c2'))]} />);
    await settleToggles();
    expect(logs().map((log) => log.open)).toEqual([false, true]);
  });
});
