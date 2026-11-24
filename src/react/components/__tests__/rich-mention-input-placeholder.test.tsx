// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatTransport, ComposerConfig } from '../../types.js';
import { MentionInput } from '../mention-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

// #11: the placeholder of the pill composer stays visible while the editor is
// focused and empty, like a native placeholder. `placeholderOnFocus={false}`
// (or `composer.placeholderOnFocus: false` on the provider) hides it on focus,
// as before.

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const placeholderOf = (container: HTMLElement) => container.querySelector('[data-element="placeholder"]');

async function type(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => { fireEvent.input(editor); });
}

async function clear(editor: HTMLElement) {
  editor.textContent = '';
  await act(async () => { fireEvent.input(editor); });
}

describe('RichMentionInput placeholder', () => {
  afterEach(cleanup);

  it('stays visible while the empty editor is focused and hides once text is typed', async () => {
    const { container } = render(<RichMentionInput placeholder="Ask anything" onSearch={() => []} />);
    const editor = screen.getByRole('textbox');
    expect(placeholderOf(container)?.textContent).toBe('Ask anything');
    act(() => { fireEvent.focus(editor); });
    expect(placeholderOf(container)?.textContent).toBe('Ask anything');
    await type(editor, 'Hi');
    expect(placeholderOf(container)).toBeNull();
    await clear(editor);
    expect(placeholderOf(container)?.textContent).toBe('Ask anything');
  });

  it('hides once a chip is in the editor', async () => {
    const ref = { current: null as null | import('../../types.js').RichMentionInputHandle };
    const { container } = render(<RichMentionInput ref={ref} placeholder="Ask anything" onSearch={() => []} />);
    act(() => { fireEvent.focus(screen.getByRole('textbox')); });
    await act(async () => { ref.current!.insertMention({ id: '7', type: 'task', label: 'Task 7' }); });
    expect(placeholderOf(container)).toBeNull();
  });

  it('placeholderOnFocus={false} hides it while focused, as before', async () => {
    const { container } = render(
      <RichMentionInput placeholder="Ask anything" placeholderOnFocus={false} onSearch={() => []} />,
    );
    const editor = screen.getByRole('textbox');
    expect(placeholderOf(container)?.textContent).toBe('Ask anything');
    act(() => { fireEvent.focus(editor); });
    expect(placeholderOf(container)).toBeNull();
    act(() => { fireEvent.blur(editor); });
    expect(placeholderOf(container)?.textContent).toBe('Ask anything');
  });
});

const tickets: ChatCompletionProvider = { id: 'tickets', trigger: '#', search: () => [] };

function Composer({ composer }: { composer?: ComposerConfig }) {
  const providers = useMemo(() => [tickets], []);
  return (
    <AiChatProvider transport={transport()} completionProviders={providers} composer={composer}>
      <MentionInput />
    </AiChatProvider>
  );
}

describe('provider composer placeholderOnFocus', () => {
  afterEach(cleanup);

  it('keeps the placeholder on focus by default', () => {
    const { container } = render(<Composer />);
    act(() => { fireEvent.focus(screen.getByRole('textbox')); });
    expect(placeholderOf(container)).not.toBeNull();
  });

  it('composer.placeholderOnFocus: false reaches the built-in composer', () => {
    const { container } = render(<Composer composer={{ placeholderOnFocus: false }} />);
    expect(placeholderOf(container)).not.toBeNull();
    act(() => { fireEvent.focus(screen.getByRole('textbox')); });
    expect(placeholderOf(container)).toBeNull();
  });
});
