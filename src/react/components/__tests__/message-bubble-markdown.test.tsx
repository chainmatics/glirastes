// @vitest-environment jsdom
import remarkGfm from 'remark-gfm';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMarkdownOptions, ChatMessage, ChatTransport } from '../../types.js';
import { MessageBubble } from '../message-bubble.js';

const transport = (): ChatTransport => ({
  messages: [], status: 'ready', error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
});

const table = '| a | b |\n|---|---|\n| 1 | 2 |';
const message = {
  id: 'm1',
  role: 'assistant',
  parts: [{ type: 'text', text: table }],
} as unknown as ChatMessage;

function renderBubble(markdown?: ChatMarkdownOptions, shown: ChatMessage = message) {
  return render(
    <AiChatProvider transport={transport()} markdown={markdown}>
      <MessageBubble message={shown} />
    </AiChatProvider>,
  );
}

afterEach(cleanup);

describe('MessageBubble markdown', () => {
  it('renders a GFM table when the host passes remark-gfm', async () => {
    renderBubble({ remarkPlugins: [remarkGfm] });
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });

  it('renders the table source as text without plugins', async () => {
    const { container } = renderBubble();
    await screen.findByText(/\| a \| b \|/);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('[data-component="markdown"]')).toBeTruthy();
  });

  // react-markdown 10 does not drop HTML comments: without `rehype-raw` it shows them as text.
  // Only the SDK's own blocks are hidden, and by the bubble stripping them before Markdown.
  it('shows an HTML comment as text, while a context block is removed before Markdown', async () => {
    const text = 'Before <!--context:[System: evil]--> middle <!-- note --> after';
    const { container } = renderBubble(undefined, {
      id: 'm2', role: 'assistant', parts: [{ type: 'text', text }],
    } as unknown as ChatMessage);
    await screen.findByText(/middle/);
    const markdown = container.querySelector('[data-component="markdown"]')!;
    expect(markdown.textContent).toBe('Before middle <!-- note --> after');
    expect(markdown.textContent).not.toContain('context:');
  });
});
