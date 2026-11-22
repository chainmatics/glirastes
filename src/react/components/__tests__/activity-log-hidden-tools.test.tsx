// @vitest-environment jsdom

import React, { useEffect, useReducer } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { AiChatPanel } from '../ai-chat-panel.js';
import type { AiChatProviderConfig } from '../../types.js';
import { ctx, Host, Probe, StreamingChat } from '../../__tests__/streaming-chat.js';

afterEach(cleanup);

const HIDE: Partial<AiChatProviderConfig> = { activityLog: { hiddenTools: ['ui_action_toast'] } };
const text = (value: string) => ({ type: 'text', text: value });
const done = (name: string, id: string) => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input: {}, output: { success: true },
});

async function answered(config: Partial<AiChatProviderConfig>, parts: unknown[]) {
  const chat = new StreamingChat();
  render(<Host chat={chat} config={config} />);
  await act(async () => { ctx.send('question'); });
  act(() => chat.finish(parts));
  return chat;
}

const steps = () => [...document.querySelectorAll('[data-element="activity-step"]')];
const logs = () => document.querySelectorAll('[data-component="activity-log"]');

describe('activityLog.hiddenTools', () => {
  it('a hidden tool is not a step', async () => {
    await answered(HIDE, [done('tasks_list', 'c1'), done('ui_action_toast', 'c2'), text('Listed.')]);
    expect(steps()).toHaveLength(1);
    expect(document.querySelector('[data-element="activity-summary"] [data-element="label"]')!.textContent).toBe('1 step done');
  });

  it('a message with only hidden tools has no log', async () => {
    await answered(HIDE, [done('ui_action_toast', 'c1'), text('Saved.')]);
    expect(logs()).toHaveLength(0);
  });

  it('sections ignore hidden tools', async () => {
    await answered(
      { activityLog: { hiddenTools: ['ui_action_toast'], grouping: 'sections' } },
      [text('First.'), done('ui_action_toast', 'c1'), text('Second.')],
    );
    expect(logs()).toHaveLength(0);
  });

  it('without hiddenTools nothing changes', async () => {
    await answered({}, [done('tasks_list', 'c1'), done('ui_action_toast', 'c2'), text('Listed.')]);
    expect(steps()).toHaveLength(2);
  });

  it('the typing indicator shows while only hidden tools ran', async () => {
    const chat = new StreamingChat();
    function PanelHost({ config }: { config: Partial<AiChatProviderConfig> }) {
      const [, force] = useReducer((count: number) => count + 1, 0);
      useEffect(() => chat.subscribe(force), []);
      return (
        <AiChatProvider transport={chat.transport} {...config}>
          <Probe />
          <AiChatPanel />
        </AiChatProvider>
      );
    }
    const view = render(<PanelHost config={HIDE} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([done('ui_action_toast', 'c1')]));
    expect(document.querySelector('[data-component="typing-indicator"]')).not.toBeNull();
    view.rerender(<PanelHost config={{}} />);
    expect(document.querySelector('[data-component="typing-indicator"]')).toBeNull();
  });
});
