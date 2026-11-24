// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatTransport, MentionResult } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

// #10: Enter (and Tab) that commits an IME composition (Japanese, Chinese,
// Korean input) must not send the message or pick a list entry. Browsers flag
// those keydowns with `isComposing`; Safari fires the committing keydown after
// `compositionend` with keyCode 229 only.

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function type(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => { fireEvent.input(editor); });
}

const COMPOSING_KEYDOWNS: Array<[string, KeyboardEventInit & { keyCode?: number }]> = [
  ['isComposing', { key: 'Enter', isComposing: true }],
  ['keyCode 229 (Safari after compositionend)', { key: 'Enter', keyCode: 229 }],
];

describe('IME composition and Enter', () => {
  afterEach(cleanup);
  beforeAll(() => {
    // jsdom has no layout; the list scrolls its selected entry into view.
    Element.prototype.scrollIntoView = () => {};
  });

  it.each(COMPOSING_KEYDOWNS)('RichMentionInput (plain) does not submit on Enter with %s', (_name, init) => {
    // jsdom has no innerText, so the plain editor reads as empty: allowEmptySubmit lets Enter through.
    const onSubmit = vi.fn();
    render(<RichMentionInput onSubmit={onSubmit} allowEmptySubmit />);
    const editor = screen.getByRole('textbox');
    type(editor, 'にほんご');
    fireEvent.keyDown(editor, init);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it.each(COMPOSING_KEYDOWNS)('RichMentionInput (mention mode) does not submit on Enter with %s', (_name, init) => {
    const onSubmit = vi.fn();
    render(<RichMentionInput onSubmit={onSubmit} onSearch={() => []} />);
    const editor = screen.getByRole('textbox');
    type(editor, 'にほんご');
    fireEvent.keyDown(editor, init);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('RichMentionInput does not submit while a composition is open, even without the flag on the keydown', () => {
    const onSubmit = vi.fn();
    render(<RichMentionInput onSubmit={onSubmit} onSearch={() => []} />);
    const editor = screen.getByRole('textbox');
    type(editor, 'にほんご');
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ...COMPOSING_KEYDOWNS,
    ['Tab with isComposing', { key: 'Tab', isComposing: true }],
  ] as Array<[string, KeyboardEventInit & { keyCode?: number }]>)('RichMentionInput does not pick a list entry on %s', async (_name, init) => {
    vi.useFakeTimers();
    try {
      const results: MentionResult[] = [{ id: '1', type: 'task', label: 'Task one' }];
      const onSubmit = vi.fn();
      render(<RichMentionInput onSubmit={onSubmit} onSearch={() => results} />);
      const editor = screen.getByRole('textbox');
      type(editor, '@ta');
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.getByRole('listbox')).toBeTruthy();
      fireEvent.keyDown(editor, init);
      expect(editor.querySelector('[data-mention-id]')).toBeNull();
      expect(screen.getByRole('listbox')).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.keyDown(editor, { key: 'Enter' });
      expect(editor.querySelector('[data-mention-id]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(COMPOSING_KEYDOWNS)('the plain chat textarea does not send on Enter with %s', (_name, init) => {
    const t = transport();
    render(
      <AiChatProvider transport={t}>
        <ChatInput />
      </AiChatProvider>,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'にほんご' } });
    fireEvent.keyDown(textarea, init);
    expect(t.sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe('にほんご');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(t.sendMessage).toHaveBeenCalledTimes(1);
  });
});
