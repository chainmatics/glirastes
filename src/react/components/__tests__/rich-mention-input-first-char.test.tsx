// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatComposerInput } from '../../hooks/use-chat-composer-input.js';
import { defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatTransport } from '../../types.js';
import { RichMentionInput } from '../rich-mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: () => [{ id: '7', label: 'Release prüfen' }],
  resolve: () => undefined,
});

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

/** Types like a browser: each character goes in at the live caret, then `input` fires. */
function typeAtCaret(editor: HTMLElement, text: string) {
  for (const char of text) {
    const selection = window.getSelection()!;
    let range: Range;
    if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
      range = selection.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    let node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const textNode = document.createTextNode('');
      node.insertBefore(textNode, node.childNodes[offset] ?? null);
      node = textNode;
      offset = 0;
    }
    (node as Text).insertData(offset, char);
    const caret = document.createRange();
    caret.setStart(node, offset + 1);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    act(() => { fireEvent.input(editor); });
  }
}

/**
 * The consumer pattern: a persisted draft is both the controlled `value` and
 * the hook's `initialValue`, so `initialValue` changes on every keystroke.
 */
function DraftComposer({ onValue }: { onValue: (value: string) => void }) {
  const [value, setValue] = useState('');
  const composer = useChatComposerInput({ initialValue: value });
  onValue(value);
  return (
    <RichMentionInput
      ref={composer.inputRef}
      {...composer.inputProps}
      value={value}
      onChange={(next) => {
        setValue(next);
        composer.inputProps.onChange?.(next);
      }}
      placeholder="Was möchten Sie erledigen?"
    />
  );
}

function App({ onValue }: { onValue: (value: string) => void }) {
  const interactions = useMemo(() => ({ entities: [task] }), []);
  return (
    <AiChatProvider transport={transport()} chatInteractions={interactions}>
      <DraftComposer onValue={onValue} />
    </AiChatProvider>
  );
}

afterEach(() => cleanup());

describe('RichMentionInput first character', () => {
  it('controlled input keeps typing order from empty', () => {
    let value = '';
    render(<App onValue={(next) => { value = next; }} />);
    const editor = screen.getByRole('textbox');
    act(() => { editor.focus(); });

    typeAtCaret(editor, 'Welche');

    expect(editor.textContent).toBe('Welche');
    expect(value).toBe('Welche');
  });

  it('plain controlled input keeps typing order from empty', () => {
    function Plain() {
      const [value, setValue] = useState('');
      return <RichMentionInput value={value} onChange={setValue} placeholder="Nachricht" />;
    }
    render(<Plain />);
    const editor = screen.getByRole('textbox');
    act(() => { editor.focus(); });

    typeAtCaret(editor, 'Welche');

    expect(editor.textContent).toBe('Welche');
  });

  it('controlled mention input without the hook keeps typing order from empty', () => {
    function Controlled() {
      const [value, setValue] = useState('');
      return (
        <RichMentionInput value={value} onChange={setValue} onSearch={async () => []} placeholder="Nachricht" />
      );
    }
    render(<Controlled />);
    const editor = screen.getByRole('textbox');
    act(() => { editor.focus(); });

    typeAtCaret(editor, 'Welche');

    expect(editor.textContent).toBe('Welche');
  });
});
