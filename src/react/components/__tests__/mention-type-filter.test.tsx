// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, StrictMode, useMemo, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import type { ChatInteractionsConfig, ChatMentionContext } from '../../interactions/registry.js';
import { useMentionContext } from '../../interactions/use-mention-context.js';
import { deChatLocale } from '../../locale-de.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { useChatComposerInput } from '../../hooks/use-chat-composer-input.js';
import type { AiChatProviderConfig, ChatTransport, MentionResult, RichMentionInputHandle } from '../../types.js';
import { MentionInput } from '../mention-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: { de: 'Aufgabe', en: 'Task' },
  search: (query) => [{ id: '7', label: 'Release prüfen' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
});
const person = defineChatEntity({
  type: 'person',
  label: { de: 'Person', en: 'Person' },
  search: (query) => [{ id: 'alice', label: 'Alice' }, { id: 'aufgabenbot', label: 'Aufgabenbot' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
});

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const INTERACTIONS: ChatInteractionsConfig = { entities: [task, person], locale: 'de' };

function Chat({ chat, children, ...props }: Partial<AiChatProviderConfig> & { chat: ChatTransport; children?: ReactNode }) {
  return (
    <AiChatProvider transport={chat} chatInteractions={INTERACTIONS} locale={deChatLocale} {...props}>
      {children}
      <MentionInput />
    </AiChatProvider>
  );
}

/** Edits the editor's text node in place (as typing does), caret at `caret`, then fires `input`. */
function edit(editor: HTMLElement, text: string, caret = text.length) {
  let node = editor.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE && editor.childNodes.length === 1) (node as Text).data = text;
  else {
    editor.textContent = '';
    node = editor.appendChild(document.createTextNode(text));
  }
  const range = document.createRange();
  range.setStart(node!, caret);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

const optionLabels = () => screen.queryAllByRole('option').map((option) => option.querySelector('[data-element="label"]')?.textContent);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('@<type>: suggestions in the composer', () => {
  it('offers the type above the hits, named as a filter, with its own heading and the live count', async () => {
    render(<Chat chat={transport()} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@auf');
    await waitFor(() => expect(optionLabels()).toEqual(['Aufgabe:', 'Aufgabenbot']));
    const filter = screen.getByRole('option', { name: 'Aufgabe: Nur diesen Typ durchsuchen' });
    expect(filter.getAttribute('data-mention-select')).toBe('query');
    expect(editor.getAttribute('aria-activedescendant')).toBe(filter.id);
    expect([...document.querySelectorAll('[data-element="group-heading"]')].map((heading) => heading.textContent))
      .toEqual(['Nach Typ filtern', 'Person']);
    expect(screen.getByRole('status').textContent).toBe('2 Vorschläge');
  });

  it('Enter on a type puts `@<name>:` without a pill or space, keeps the list open and searches that type', async () => {
    const chat = transport();
    render(<Chat chat={chat} />);
    const editor = screen.getByRole('textbox');
    edit(editor, 'Siehe @auf');
    await waitFor(() => expect(optionLabels()[0]).toBe('Aufgabe:'));
    expect(fireEvent.keyDown(editor, { key: 'Enter' })).toBe(false);
    expect(editor.textContent).toBe('Siehe @Aufgabe:');
    expect(editor.querySelector('[data-mention-id]')).toBeNull();
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen', 'Report schreiben']));

    // Typing on narrows inside the type; a picked hit is a normal pill of that type.
    edit(editor, 'Siehe @Aufgabe:rel');
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen']));
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-type="task"][data-mention-id="7"]')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const sent = chat.sendMessage.mock.calls[0]![0].text as string;
    expect(sent).toContain('{{mention:task:7:Release prüfen}}');
    expect(sent).not.toContain('mention-filter');
  });

  it('picks a type with Tab and with a click as well; ArrowDown reaches the hits; Escape closes', async () => {
    render(<Chat chat={transport()} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@auf');
    await waitFor(() => expect(optionLabels()[0]).toBe('Aufgabe:'));
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id);
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('@Aufgabe:');
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen', 'Report schreiben']));
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    edit(editor, '@pe');
    await waitFor(() => expect(optionLabels()[0]).toBe('Person:'));
    fireEvent.click(screen.getByRole('option', { name: 'Person: Nur diesen Typ durchsuchen' }));
    expect(editor.textContent).toBe('@Person:');
    await waitFor(() => expect(optionLabels()).toEqual(['Alice', 'Aufgabenbot']));
  });

  it('shows the commands heading from the app locale, the built-in one by the registry locale otherwise', async () => {
    const help = defineChatCommand({ id: 'help', label: 'Hilfe', run: { kind: 'tool', tool: 'help' } });
    const open = defineChatCommand({ id: 'open', label: 'Öffnen', run: { kind: 'tool', tool: 'open' } });
    const english: ChatInteractionsConfig = { entities: [task, person], commands: [help, open], locale: 'en' };
    // A German ChatLocale over an English registry keeps `Commands`, as before the key existed.
    let search: ChatContextValue['completionSearch'];
    function Probe() {
      search = useChatContext().completionSearch;
      return null;
    }
    const { unmount } = render(<Chat chat={transport()} chatInteractions={english}><Probe /></Chat>);
    expect((await search!('', '/'))[0]).toMatchObject({ group: 'Commands' });
    expect((await search!('ta', '@'))[0]).toMatchObject({ label: 'Task:', group: 'Filter by type', description: 'Search only this type' });
    unmount();
    render(
      <Chat chat={transport()} chatInteractions={english} locale={{ ...deChatLocale, completionCommandsGroupLabel: 'Polecenia', completionEntityTypesGroupLabel: 'Szukaj w', completionEntityTypeFilterLabel: 'Tylko {type}' }}>
        <Probe />
      </Chat>,
    );
    expect((await search!('', '/'))[0]).toMatchObject({ group: 'Polecenia' });
    expect((await search!('ta', '@'))[0]).toMatchObject({ group: 'Szukaj w', description: 'Tylko Task' });
  });
});

describe('mentionContext preset', () => {
  it('turns a bare @ into `@<name>:` searching that type; Backspace removes the preset in one step', async () => {
    render(<Chat chat={transport()} mentionContext={{ presetType: 'task' }} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@');
    expect(editor.textContent).toBe('@Aufgabe:');
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen', 'Report schreiben']));
    const selection = window.getSelection()!;
    expect(selection.getRangeAt(0).startOffset).toBe('@Aufgabe:'.length);

    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(false);
    expect(editor.textContent).toBe('@');
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen', 'Report schreiben', 'Alice', 'Aufgabenbot']));

    // Typing on and back to the bare trigger does not preset it again.
    edit(editor, '@a');
    edit(editor, '@');
    expect(editor.textContent).toBe('@');
  });

  it('puts no preset into an open IME composition and applies it on compositionend if the trigger is still bare', async () => {
    render(<Chat chat={transport()} mentionContext={{ presetType: 'task' }} />);
    const editor = screen.getByRole('textbox');
    fireEvent.compositionStart(editor);
    edit(editor, '@');
    expect(editor.textContent).toBe('@');
    fireEvent.compositionEnd(editor);
    expect(editor.textContent).toBe('@Aufgabe:');
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe('@Aufgabe:'.length);

    // A composition that ends with text behind the trigger gets no preset.
    edit(editor, '');
    fireEvent.compositionStart(editor);
    edit(editor, '@');
    edit(editor, '@た');
    fireEvent.compositionEnd(editor);
    expect(editor.textContent).toBe('@た');

    // An input event that reports isComposing gets none either.
    edit(editor, '');
    editor.textContent = '@';
    const range = document.createRange();
    range.setStart(editor.firstChild!, 1);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.input(editor, { isComposing: true });
    expect(editor.textContent).toBe('@');
  });

  it('lets Backspace work per character once the user typed after the preset', async () => {
    render(<Chat chat={transport()} mentionContext={{ presetType: 'task' }} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@');
    expect(editor.textContent).toBe('@Aufgabe:');
    edit(editor, '@Aufgabe:r');
    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(true);
  });

  it('never presets `/` or an unknown type, and presets again for a new @', async () => {
    const { rerender } = render(<Chat chat={transport()} mentionContext={{ presetType: 'nope' }} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@');
    expect(editor.textContent).toBe('@');
    rerender(<Chat chat={transport()} mentionContext={{ presetType: 'person' }} />);
    edit(editor, '/');
    expect(editor.textContent).toBe('/');
    edit(editor, '');
    edit(editor, 'hi @');
    expect(editor.textContent).toBe('hi @Person:');
  });

  it('orders the @ list by preferredTypes', async () => {
    render(<Chat chat={transport()} mentionContext={{ preferredTypes: ['person'] }} />);
    edit(screen.getByRole('textbox'), '@');
    await waitFor(() => expect(optionLabels()).toEqual(['Alice', 'Aufgabenbot', 'Release prüfen', 'Report schreiben']));
  });

  it('useMentionContext wins over the prop while mounted, the latest mounted wins, unmount restores', async () => {
    function Page({ value }: { value: ChatMentionContext | null }) {
      useMentionContext(value);
      return null;
    }
    function App() {
      const [pages, setPages] = useState<Array<ChatMentionContext | null>>([]);
      return (
        <Chat chat={chat} mentionContext={{ presetType: 'task' }}>
          {pages.map((value, index) => <Page key={index} value={value} />)}
          <button type="button" onClick={() => setPages((list) => [...list, { presetType: 'person' }])}>person</button>
          <button type="button" onClick={() => setPages((list) => [...list, null])}>none</button>
          <button type="button" onClick={() => setPages((list) => list.slice(0, -1))}>pop</button>
        </Chat>
      );
    }
    const chat = transport();
    render(<App />);
    const editor = screen.getByRole('textbox');
    const presetOf = () => {
      edit(editor, '');
      edit(editor, '@');
      return editor.textContent;
    };
    expect(presetOf()).toBe('@Aufgabe:');
    fireEvent.click(screen.getByText('person'));
    expect(presetOf()).toBe('@Person:');
    // A mounted hook with `null` contributes nothing.
    fireEvent.click(screen.getByText('none'));
    expect(presetOf()).toBe('@Person:');
    fireEvent.click(screen.getByText('pop'));
    fireEvent.click(screen.getByText('pop'));
    expect(presetOf()).toBe('@Aufgabe:');
  });

  it('the call rendered last wins: nested over its page, a later sibling, a later mount (StrictMode too)', async () => {
    function Context({ type, children }: { type: string; children?: ReactNode }) {
      useMentionContext({ presetType: type });
      return <>{children}</>;
    }
    function App({ panel, strict }: { panel: 'nested' | 'sibling' | 'late'; strict?: boolean }) {
      const [late, setLate] = useState(false);
      const tree = (
        <Chat chat={transport()} mentionContext={{ presetType: 'nope' }}>
          {panel === 'nested' && <Context type="task"><Context type="person" /></Context>}
          {panel === 'sibling' && <><Context type="task" /><Context type="person" /></>}
          {panel === 'late' && <Context type="person">{late && <Context type="task" />}</Context>}
          <button type="button" onClick={() => setLate(true)}>late</button>
        </Chat>
      );
      return strict ? <StrictMode>{tree}</StrictMode> : tree;
    }
    const presetOf = () => {
      const editor = screen.getByRole('textbox');
      edit(editor, '');
      edit(editor, '@');
      return editor.textContent;
    };
    for (const strict of [false, true]) {
      render(<App panel="nested" strict={strict} />);
      expect(presetOf()).toBe('@Person:');
      cleanup();
      render(<App panel="sibling" strict={strict} />);
      expect(presetOf()).toBe('@Person:');
      cleanup();
      render(<App panel="late" strict={strict} />);
      expect(presetOf()).toBe('@Person:');
      fireEvent.click(screen.getByText('late'));
      expect(presetOf()).toBe('@Aufgabe:');
      cleanup();
    }
  });

  it('presets openCompletion({ trigger: "@" }) without a query; Backspace leaves an armed bare @', async () => {
    const ref = createRef<RichMentionInputHandle>();
    function Custom() {
      const composer = useChatComposerInput();
      return <RichMentionInput ref={(handle) => { composer.inputRef.current = handle; (ref as { current: RichMentionInputHandle | null }).current = handle; }} {...composer.inputProps} />;
    }
    render(
      <AiChatProvider transport={transport()} chatInteractions={INTERACTIONS} mentionContext={{ presetType: 'task' }}>
        <Custom />
      </AiChatProvider>,
    );
    const editor = screen.getByRole('textbox');
    act(() => { ref.current!.openCompletion!({ trigger: '@' }); });
    expect(editor.textContent).toBe('@Aufgabe:');
    await waitFor(() => expect(optionLabels()).toEqual(['Release prüfen', 'Report schreiben']));
    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(false);
    expect(editor.textContent).toBe('@');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('');

    // With a query or a source, no preset.
    act(() => { ref.current!.openCompletion!({ trigger: '@', query: 'Al' }); });
    expect(editor.textContent).toBe('@Al');
    fireEvent.keyDown(editor, { key: 'Escape' });
    act(() => { ref.current!.openCompletion!({ trigger: '@', source: 'chat-entities' }); });
    expect(editor.textContent).toBe('@');
  });
});

describe('RichMentionInput without the composer', () => {
  it('keeps a bare trigger bare with an own onSearch and no completionPreset', async () => {
    const onSearch = vi.fn(async () => [] as MentionResult[]);
    render(<RichMentionInput onSearch={onSearch} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '@');
    expect(editor.textContent).toBe('@');
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('', '@'));
  });

  it('applies an own completionPreset and runs a `select: query` entry of an own onSearch', async () => {
    const onSearch = vi.fn(async (query: string): Promise<MentionResult[]> => (
      query.startsWith('tag:')
        ? [{ id: 'bug', type: 'tag', label: 'bug' }]
        : [{ id: 'tag', type: 'refine', label: 'tag:', select: 'query' }]
    ));
    const preset = vi.fn((trigger: string) => (trigger === '#' ? 'tag:' : undefined));
    render(<RichMentionInput onSearch={onSearch} triggers={['@', '#']} completionPreset={preset} />);
    const editor = screen.getByRole('textbox');
    edit(editor, '#');
    expect(editor.textContent).toBe('#tag:');
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith('tag:', '#'));
    edit(editor, '@');
    expect(editor.textContent).toBe('@');
    edit(editor, '@x');
    await waitFor(() => expect(optionLabels()).toEqual(['tag:']));
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.textContent).toBe('@tag:');
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith('tag:', '@'));
    expect(editor.querySelector('[data-mention-id]')).toBeNull();
  });
});

describe('useChatComposerInput', () => {
  it('hands the preset to an own composer through inputProps', () => {
    let props: Record<string, unknown> = {};
    function Custom() {
      const composer = useChatComposerInput();
      props = composer.inputProps as Record<string, unknown>;
      return <RichMentionInput ref={composer.inputRef} {...composer.inputProps} />;
    }
    const interactions = INTERACTIONS;
    function App() {
      const context = useMemo(() => ({ presetType: 'person' }), []);
      return <AiChatProvider transport={transport()} chatInteractions={interactions} mentionContext={context}><Custom /></AiChatProvider>;
    }
    render(<App />);
    expect(typeof props.completionPreset).toBe('function');
    edit(screen.getByRole('textbox'), '@');
    expect(screen.getByRole('textbox').textContent).toBe('@Person:');
  });

  it('passes no preset without chatInteractions', () => {
    let props: Record<string, unknown> = {};
    function Custom() {
      const composer = useChatComposerInput();
      props = composer.inputProps as Record<string, unknown>;
      return null;
    }
    render(<AiChatProvider transport={transport()} completionProviders={[{ id: 'x', trigger: '@', search: () => [] }]}><Custom /></AiChatProvider>);
    expect('completionPreset' in props).toBe(false);
  });
});
