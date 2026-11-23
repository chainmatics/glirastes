// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

afterEach(cleanup);

/**
 * An app that stores the history with `session.save` but hands it to its own
 * transport (for example `useChat({ messages })`) instead of `session.load`.
 */
describe('a stored history the app gives to its own transport', () => {
  const stored = () => [
    {
      id: 'u0', role: 'user', parts: [{ type: 'text', text: 'earlier' }],
      metadata: { app: 'kept', glirastesTurnOutcome: { status: 'aborted', reason: 'stopped', at: 'x' } },
    },
    { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
  ] as unknown as ChatMessage[];

  it('is shown with its outcome, and the key never reaches a request; the app\'s objects stay as they were', async () => {
    const chat = new StreamingChat();
    const history = stored();
    const snapshot = structuredClone(history);
    chat.messages = history;
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.turnOutcomes?.get('u0')?.status).toBe('aborted'));
    expect((chat.messages[0] as { metadata?: unknown }).metadata).toEqual({ app: 'kept' });
    expect(history).toEqual(snapshot);
    await act(async () => { ctx.send('next'); });
    expect(JSON.stringify(chat.requests.at(-1))).not.toContain('glirastesTurnOutcome');
    expect((chat.requests.at(-1)![0] as { metadata?: unknown }).metadata).toEqual({ app: 'kept' });
  });

  it('a history without the key is left alone (same array, no setMessages)', async () => {
    const chat = new StreamingChat();
    const history = [{ id: 'u0', role: 'user', parts: [{ type: 'text', text: 'q' }], metadata: { app: 1 } }] as unknown as ChatMessage[];
    chat.messages = history;
    render(<Host chat={chat} />);
    await act(async () => {});
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(chat.messages).toBe(history);
  });
});
