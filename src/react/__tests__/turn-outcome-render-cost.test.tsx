// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const COUNT = 500;

/**
 * A `completed` outcome is recorded for every turn, so `turnOutcomes` is
 * almost never empty: finding the turn of a message must not scan the whole
 * history once per message and render (quadratic while a long chat streams).
 */
describe('finding the turn of each message while rendering', () => {
  it(`scans a ${COUNT}-message history a bounded number of times per render, not once per message`, async () => {
    const chat = new StreamingChat();
    const history: ChatMessage[] = [];
    for (let i = 0; i < COUNT / 2; i += 1) {
      history.push({ id: `u-${i}`, role: 'user', parts: [{ type: 'text', text: `q${i}` }] });
      history.push({ id: `a-${i}`, role: 'assistant', parts: [{ type: 'text', text: `a${i}` }] });
    }
    chat.messages = history;
    render(<Host chat={chat} />);
    // Every message visible, and one finished turn so the outcome map is not empty.
    await act(async () => { for (let i = 0; i < COUNT / 10; i += 1) ctx.loadMore(); });
    await act(async () => { ctx.send('next'); });
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(ctx.turnOutcomes?.size).toBe(1));
    expect(ctx.messages.length).toBeGreaterThanOrEqual(COUNT);

    const findIndex = Array.prototype.findIndex;
    let scans = 0;
    vi.spyOn(Array.prototype, 'findIndex').mockImplementation(function (this: unknown[], ...args) {
      if (this.length >= COUNT) scans += 1;
      return findIndex.apply(this, args as Parameters<typeof findIndex>);
    });
    // One streamed chunk: one render of the list and its bubbles.
    await act(async () => { ctx.send('more'); });
    await act(async () => { chat.stream([{ type: 'text', text: 'chunk' }]); });
    expect(scans).toBeLessThanOrEqual(10);
  });
});
