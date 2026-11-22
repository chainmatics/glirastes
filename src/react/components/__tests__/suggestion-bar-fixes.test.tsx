// @vitest-environment jsdom

import React, { useEffect, useReducer } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { SuggestionBar } from '../suggestion-bar.js';
import type { AiChatProviderConfig } from '../../types.js';
import { ctx, Probe, StreamingChat } from '../../__tests__/streaming-chat.js';

afterEach(cleanup);

function BarHost({ chat, config }: { chat: StreamingChat; config?: Partial<AiChatProviderConfig> }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
      <SuggestionBar />
    </AiChatProvider>
  );
}

const text = (value: string) => ({ type: 'text', text: value });
const followups = (list: string[]) => ({
  type: 'tool-suggest_followups', toolCallId: `f-${list.join('-')}`, state: 'output-available', input: {}, output: { followups: list },
});
const chip = () => document.querySelector('[data-component="suggestion-bar"]')?.textContent ?? null;

async function turn(chat: StreamingChat, question: string, parts: unknown[]) {
  await act(async () => { ctx.send(question); });
  act(() => chat.finish(parts));
}

describe('SuggestionBar honours suggestions.enabled: false', () => {
  it('shows no follow-up chip', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} config={{ suggestions: { enabled: false } }} />);
    await turn(chat, 'one', [text('answer'), followups(['A'])]);
    expect(chip()).toBeNull();
  });

  it('shows no static chip', () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} config={{ suggestions: { enabled: false, staticChips: ['Start here'] } }} />);
    expect(chip()).toBeNull();
  });

  it('enabled (default) still shows them', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} />);
    await turn(chat, 'one', [text('answer'), followups(['A'])]);
    expect(chip()).toBe('A');
  });
});

describe('SuggestionBar drops the previous turn\'s follow-ups', () => {
  it('a turn without follow-ups shows none', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} />);
    await turn(chat, 'one', [text('first'), followups(['A'])]);
    expect(chip()).toBe('A');
    await turn(chat, 'two', [text('second')]);
    expect(ctx.suggestionChips).toEqual([]);
    expect(chip()).toBeNull();
  });

  it('the static chips come back instead', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} config={{ suggestions: { staticChips: ['Start here'] } }} />);
    expect(chip()).toBe('Start here');
    await turn(chat, 'one', [text('first'), followups(['A'])]);
    expect(chip()).toBe('A');
    await turn(chat, 'two', [text('second')]);
    expect(ctx.suggestionChips).toEqual(['Start here']);
  });

  it('a retry without follow-ups drops the chips of the first attempt', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} />);
    await turn(chat, 'one', [text('first'), followups(['A'])]);
    expect(chip()).toBe('A');
    act(() => chat.retry());
    act(() => chat.finish([text('again')]));
    expect(chip()).toBeNull();
  });

  it('a later turn with follow-ups shows its own', async () => {
    const chat = new StreamingChat();
    render(<BarHost chat={chat} />);
    await turn(chat, 'one', [text('first'), followups(['A'])]);
    await turn(chat, 'two', [text('second'), followups(['B'])]);
    expect(ctx.suggestionChips).toEqual(['B']);
  });
});
