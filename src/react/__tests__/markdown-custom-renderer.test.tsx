// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MarkdownProps } from '../types.js';
import { Host, StreamingChat } from './streaming-chat.js';

const loads = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-markdown', async () => {
  loads.count += 1;
  return await vi.importActual<typeof import('react-markdown')>('react-markdown');
});

afterEach(cleanup);

function OwnMarkdown({ content }: MarkdownProps) {
  return <div data-testid="own-markdown">{content}</div>;
}

describe('an app with its own Markdown renderer', () => {
  it('renders through it at once: no placeholder, and react-markdown is not loaded on its behalf', async () => {
    const chat = new StreamingChat();
    chat.messages = [
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] },
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: '- **eins**' }] },
    ] as unknown as ChatMessage[];
    render(<Host chat={chat} config={{ components: { Markdown: OwnMarkdown } }} />);
    expect(screen.getAllByTestId('own-markdown').map((node) => node.textContent)).toEqual(['Hallo', '- **eins**']);
    expect(document.querySelector('[data-state="loading"]')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loads.count).toBe(0);
  });
});
