// @vitest-environment jsdom
import React, { createRef, useMemo } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { useChatComposerInput } from '../../hooks/use-chat-composer-input.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatTransport, MentionResult, RichMentionInputHandle } from '../../types.js';
import { MentionInput } from '../mention-input.js';
import { RichMentionInput } from '../rich-mention-input.js';
import { createCompletionSearch } from '../../completions/completion-search.js';

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function caretAt(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function caret(): { node: Node; offset: number } {
  const range = window.getSelection()!.getRangeAt(0);
  return { node: range.startContainer, offset: range.startOffset };
}

/** What the browser does when the user types `text` at the caret. */
function typeAtCaret(editor: HTMLElement, text: string) {
  const { node, offset } = caret();
  (node as Text).insertData(offset, text);
  caretAt(node, offset + text.length);
  fireEvent.input(editor);
}

const option = (label: string) => screen.getByRole('option', { name: label });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('RichMentionInput openCompletion', () => {
  const results: MentionResult[] = [{ id: '7', type: 'person', label: 'Müller' }];

  function renderEditor(search = vi.fn(async (_query: string, _trigger: string) => results)) {
    const ref = createRef<RichMentionInputHandle>();
    const onChange = vi.fn();
    render(<RichMentionInput ref={ref} onSearch={search} onChange={onChange} triggers={['@', '/', '#']} />);
    return { ref, search, onChange, editor: screen.getByRole('textbox') };
  }

  function fill(editor: HTMLElement, text: string) {
    editor.textContent = text;
  }

  it('inserts the trigger into an empty editor, focuses it and opens the list at once', async () => {
    const { ref, search, editor } = renderEditor();
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('@');
    expect(document.activeElement).toBe(editor);
    // No debounce: the search ran synchronously with the call.
    expect(search).toHaveBeenCalledWith('', '@');
    await screen.findByRole('listbox');
    expect(ref.current!.getValue()).toBe('@');
  });

  it('adds a space before the trigger when the text ends without one', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('Hallo @');
    await screen.findByRole('listbox');
    expect(caret()).toEqual({ node: editor.firstChild, offset: 'Hallo @'.length });
  });

  it('adds no space after existing whitespace', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo ');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('Hallo @');
    await screen.findByRole('listbox');
  });

  it('Escape with nothing typed removes the inserted text and restores the caret', async () => {
    const { ref, editor, onChange } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await screen.findByRole('listbox');

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Hallo');
    expect(screen.queryByRole('listbox')).toBeNull();
    const { node, offset } = caret();
    expect(editor.contains(node)).toBe(true);
    expect((node.textContent ?? '').slice(0, offset)).toBe('Hallo');
    expect(onChange).toHaveBeenLastCalledWith('Hallo');
  });

  it('keeps the caret where it was when the editor already had focus', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo Welt');
    editor.focus();
    caretAt(editor.firstChild!, 5);
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('Hallo @ Welt');
    await screen.findByRole('listbox');

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Hallo Welt');
    expect(caret()).toEqual({ node: editor.firstChild, offset: 5 });
  });

  it('typing after the trigger disarms it: Escape keeps the text', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await screen.findByRole('listbox');

    typeAtCaret(editor, 'x');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Hallo @x');
  });

  it('outside click and blur remove the untouched text too', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await screen.findByRole('listbox');
    fireEvent.mouseDown(document.body);
    expect(editor.textContent).toBe('Hallo');

    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await screen.findByRole('listbox');
    fireEvent.blur(editor);
    expect(editor.textContent).toBe('Hallo');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('removes the text when the search finds nothing', async () => {
    const { ref, editor } = renderEditor(vi.fn(async () => []));
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await waitFor(() => expect(editor.textContent).toBe('Hallo'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a pick disarms: the pill stays when the list closes', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@', query: 'Mül' }); });
    expect(editor.textContent).toBe('Hallo @Mül');
    fireEvent.click(await screen.findByRole('option', { name: 'Müller' }));
    expect(editor.querySelector('[data-mention-id="7"]')).not.toBeNull();
    fireEvent.blur(editor);
    expect(editor.querySelector('[data-mention-id="7"]')).not.toBeNull();
  });

  it('searches the query; an own onSearch gets only query and trigger, also with a source', async () => {
    const { ref, search } = renderEditor();
    act(() => { ref.current!.openCompletion!({ trigger: '@', query: 'Mül', source: 'people' }); });
    expect(search).toHaveBeenCalledWith('Mül', '@');
    expect(search.mock.calls.at(-1)).toHaveLength(2);
    await screen.findByRole('listbox');
  });

  it('narrows a search from createCompletionSearch to the source providers, also while typing on', async () => {
    const people: ChatCompletionProvider = { id: 'people', trigger: '@', search: vi.fn(() => [{ id: '1', type: 'person', label: 'Anna Müller' }]) };
    const teams: ChatCompletionProvider = { id: 'teams', trigger: '@', search: vi.fn(() => [{ id: '2', type: 'team', label: 'Müller Team' }]) };
    const ref = createRef<RichMentionInputHandle>();
    render(<RichMentionInput ref={ref} onSearch={createCompletionSearch([people, teams])} />);
    const editor = screen.getByRole('textbox');
    act(() => { ref.current!.openCompletion!({ trigger: '@', source: 'people' }); });
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([expect.stringContaining('Anna Müller')]);
    expect(teams.search).not.toHaveBeenCalled();
    typeAtCaret(editor, 'Mü');
    await waitFor(() => expect(people.search).toHaveBeenCalledTimes(2));
    expect(teams.search).not.toHaveBeenCalled();
  });

  it('a second call while armed replaces the armed text', async () => {
    const { ref, search, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@', query: 'Mül' }); });
    act(() => { ref.current!.openCompletion!({ trigger: '#' }); });
    expect(editor.textContent).toBe('Hallo #');
    expect(search).toHaveBeenLastCalledWith('', '#');
    await screen.findByRole('listbox');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Hallo');
  });

  it('called while a typed list is open, inserts behind the typed query and keeps it on close', async () => {
    const { ref, search, editor } = renderEditor();
    editor.focus();
    fill(editor, 'Hallo @mü');
    caretAt(editor.firstChild!, 'Hallo @mü'.length);
    fireEvent.input(editor);
    await screen.findByRole('listbox');

    act(() => { ref.current!.openCompletion!({ trigger: '#' }); });
    expect(editor.textContent).toBe('Hallo @mü #');
    expect(search).toHaveBeenLastCalledWith('', '#');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Hallo @mü');
  });

  it('insertMention while armed removes the untouched trigger before the pill goes in', async () => {
    const { ref, editor } = renderEditor();
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    await screen.findByRole('listbox');
    act(() => { ref.current!.insertMention({ id: '9', type: 'person', label: 'Schulz', prefix: '@', slug: 'Schulz' }); });
    expect(editor.textContent!.startsWith('Hallo @Schulz')).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    // A later blur must not change the text any more (nothing stays armed).
    const before = ref.current!.getValue();
    fireEvent.blur(editor);
    expect(ref.current!.getValue()).toBe(before);
    expect(before).toBe('Hallo @Schulz');
  });

  it('Enter before the results arrived removes the untouched trigger and sends nothing', async () => {
    const ref = createRef<RichMentionInputHandle>();
    const onSubmit = vi.fn();
    const search = vi.fn(() => new Promise<MentionResult[]>(() => {}));
    render(<RichMentionInput ref={ref} onSearch={search} onSubmit={onSubmit} triggers={['@']} />);
    const editor = screen.getByRole('textbox');
    fill(editor, 'Hallo');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('Hallo @');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Hallo');
    // The next Enter sends the text as usual.
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('Hallo', []);
  });

  it('an unknown trigger warns once and does nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ref, search, editor } = renderEditor();
    act(() => { ref.current!.openCompletion!({ trigger: '!' }); });
    act(() => { ref.current!.openCompletion!({ trigger: '!' }); });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe('');
    expect(search).not.toHaveBeenCalled();
  });
});

const people: ChatCompletionProvider = {
  id: 'people', trigger: '@', search: ({ query }) => [{ id: 'p1', type: 'person', label: `Person ${query}`.trim() }],
};
const tasks: ChatCompletionProvider = {
  id: 'tasks', trigger: '@', search: () => [{ id: 't1', type: 'task', label: 'Aufgabe' }],
};

let composer: ChatComposer;
function Grab() {
  composer = useChatComposer();
  return null;
}

function Toolbar() {
  const input = useChatComposerInput();
  return (
    <div>
      <RichMentionInput ref={input.inputRef} {...input.inputProps} />
      <button type="button" onClick={() => input.openCompletion({ trigger: '@', source: 'people' })}>People</button>
    </div>
  );
}

function Chat({ showInput = true, custom = false }: { showInput?: boolean; custom?: boolean }) {
  const providers = useMemo(() => [people, tasks], []);
  const chat = useMemo(() => transport(), []);
  return (
    <AiChatProvider transport={chat} completionProviders={providers}>
      <Grab />
      {showInput && (custom ? <Toolbar /> : <MentionInput />)}
    </AiChatProvider>
  );
}

describe('openCompletion on the composer', () => {
  it('controls.openCompletion with source shows only that provider', async () => {
    render(<Chat custom />);
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    await waitFor(() => expect(option('Person')).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Aufgabe' })).toBeNull();
    expect(screen.getByRole('textbox').textContent).toBe('@');
  });

  it('useChatComposer().openCompletion before the composer mounted runs once it mounts', async () => {
    const { rerender } = render(<Chat showInput={false} />);
    act(() => { composer.openCompletion({ trigger: '@', query: 'Mül' }); });
    rerender(<Chat />);
    await waitFor(() => expect(option('Person Mül')).toBeTruthy());
    expect(option('Aufgabe')).toBeTruthy();
    expect(screen.getByRole('textbox').textContent).toBe('@Mül');
  });
});
