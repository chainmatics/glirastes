// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { AssistantLayoutProvider, useAssistantLayout } from '../../assistant/assistant-layout.js';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatTransport, MentionResult, RichMentionInputHandle } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen' }].filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
});
const team = defineChatEntity({ type: 'team', label: 'Team', search: () => [] });

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
  defineChatCommand({
    id: 'tasks.summarize',
    label: 'Summarize',
    args: [{ name: 'taskId', label: 'Task', required: true, entity: 'task' }],
    run: { kind: 'tool', tool: 'tasks.summarize' },
  }),
  defineChatCommand({
    id: 'tasks.archive',
    label: 'Archive',
    args: [{ name: 'taskId', label: 'Task', required: true }],
    run: { kind: 'tool', tool: 'tasks.archive' },
  }),
];

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
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

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  caretAt(editor.firstChild!, text.length);
  fireEvent.input(editor);
}

const PILL = '[data-component="mention-chip"]';
const flushFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await flushFrame();
  cleanup();
  vi.restoreAllMocks();
});

describe('pills in RichMentionInput', () => {
  const results: MentionResult[] = [
    { id: 'open.overview', type: 'command', label: 'Open Overview' },
    { id: '7', type: 'task', label: 'Release prüfen' },
  ];
  const search = async (query: string, trigger: string) => results.filter((result) => (trigger === '/') === (result.type === 'command'));

  function renderEditor(props: Partial<Parameters<typeof RichMentionInput>[0]> = {}) {
    const ref = createRef<RichMentionInputHandle>();
    const onChange = vi.fn();
    render(<RichMentionInput ref={ref} onSearch={search} onChange={onChange} {...props} />);
    return { ref, onChange, editor: screen.getByRole('textbox') };
  }

  it('turns a picked / command into a command pill and an @ entity into an entity pill', async () => {
    const { editor } = renderEditor();
    typeInto(editor, '/op');
    await screen.findByRole('listbox');
    fireEvent.keyDown(editor, { key: 'Enter' });
    const command = editor.querySelector('[data-mention-id="open.overview"]') as HTMLElement;
    expect(command.dataset.mentionKind).toBe('command');
    expect(command.dataset.mentionPrefix).toBe('/');
    expect(command.contentEditable).toBe('false');

    const after = command.nextSibling as Text;
    after.textContent = ' @rel';
    caretAt(after, after.length);
    fireEvent.input(editor);
    await screen.findByRole('listbox');
    fireEvent.keyDown(editor, { key: 'Tab' });
    const entity = editor.querySelector('[data-mention-id="7"]') as HTMLElement;
    expect(entity.dataset.mentionKind).toBe('entity');
    expect(entity.dataset.mentionPrefix).toBe('@');
    expect(entity.querySelector('[data-action="remove-mention"]')?.getAttribute('aria-label')).toBe('Remove Release prüfen');
  });

  it('keeps a picked command as text with commandPills={false}', async () => {
    const { editor } = renderEditor({ commandPills: false });
    typeInto(editor, '/op');
    await screen.findByRole('listbox');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.querySelector('[data-mention-id]')).toBeNull();
    expect(editor.textContent).toBe('/open-overview ');
  });

  it('removes the pill before the caret with Backspace and the one after it with Delete', () => {
    const { ref, editor, onChange } = renderEditor();
    act(() => {
      ref.current!.setValue('/open-overview und @release-prufen', [
        { id: 'open.overview', type: 'command', label: 'Open Overview', prefix: '/', slug: 'open-overview' },
        { id: '7', type: 'task', label: 'Release prüfen', prefix: '@', slug: 'release-prufen' },
      ]);
    });
    const [command, entity] = Array.from(editor.querySelectorAll<HTMLElement>(PILL));
    // Caret right behind the entity pill: in the editor itself, as browsers leave it after a pill.
    caretAt(editor, Array.from(editor.childNodes).indexOf(entity!) + 1);
    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(false);
    expect(editor.querySelector('[data-mention-id="7"]')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('/open-overview und');

    // Caret at the start of the editor, before the command pill's empty leading text node.
    caretAt(editor.firstChild!, 0);
    expect(fireEvent.keyDown(editor, { key: 'Delete' })).toBe(false);
    expect(editor.contains(command!)).toBe(false);
  });

  it('leaves typing alone when no pill is next to the caret', () => {
    const { ref, editor } = renderEditor();
    act(() => {
      ref.current!.setValue('@release-prufen danach', [{ id: '7', type: 'task', label: 'Release prüfen', prefix: '@', slug: 'release-prufen' }]);
    });
    const text = editor.lastChild as Text;
    caretAt(text, 4);
    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(true);
    expect(editor.querySelector('[data-mention-id="7"]')).not.toBeNull();
  });

  it('inserts a pill at the end with spaces around it, and at the caret inside text', () => {
    const { ref, editor, onChange } = renderEditor();
    act(() => { ref.current!.setValue('Bitte prüfen'); });
    act(() => { ref.current!.insertMention({ id: '7', type: 'task', label: 'Release prüfen', prefix: '@', slug: 'release-prufen' }); });
    expect(ref.current!.getValue()).toBe('Bitte prüfen @release-prufen');
    expect(onChange).toHaveBeenLastCalledWith('Bitte prüfen @release-prufen');

    caretAt(editor.firstChild!, 'Bitte'.length);
    act(() => { ref.current!.insertMention({ id: 'open.overview', type: 'command', label: 'Open Overview', prefix: '/', slug: 'open-overview' }); });
    expect(ref.current!.getValue()).toBe('Bitte /open-overview prüfen @release-prufen');
    expect(ref.current!.getMentions().map((mention) => mention.id)).toEqual(['open.overview', '7']);
  });
});

function AboutButton({ onComposer }: { onComposer: (composer: ChatComposer) => void }) {
  const composer = useChatComposer();
  onComposer(composer);
  return <button type="button">{composer.chatAboutLabel}</button>;
}

function Chat({ chat, onOpenRequest, showInput = true, locale }: {
  chat: ChatTransport; onOpenRequest?: () => void; showInput?: boolean; locale?: 'de' | 'en';
}) {
  const interactions = useMemo(() => ({ entities: [task, team], commands, locale }), [locale]);
  return (
    <AiChatProvider transport={chat} chatInteractions={interactions} onOpenRequest={onOpenRequest}>
      <AboutButton onComposer={(value) => { composer = value; }} />
      {showInput && <ChatInput />}
    </AiChatProvider>
  );
}
let composer: ChatComposer;

describe('useChatComposer', () => {
  it('opens the chat and puts the command, the entity and the text into the composer as pills', async () => {
    const onOpenRequest = vi.fn();
    render(<Chat chat={transport()} onOpenRequest={onOpenRequest} />);
    let ok = false;
    await act(async () => { ok = await composer.chatAbout({ type: 'task', id: '7', label: 'Release prüfen' }, { command: 'tasks.summarize', text: 'kurz' }); });
    expect(ok).toBe(true);
    expect(onOpenRequest).toHaveBeenCalledTimes(1);
    const editor = screen.getByRole('textbox');
    const pills = Array.from(editor.querySelectorAll<HTMLElement>(PILL));
    expect(pills.map((pill) => [pill.dataset.mentionKind, pill.dataset.mentionId])).toEqual([['command', 'tasks.summarize'], ['entity', '7']]);
    expect(editor.textContent).toContain('kurz');
    await flushFrame();
    expect(document.activeElement).toBe(editor);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('runs the command with the entity pill as its argument when sent alone', async () => {
    const chat = transport();
    render(<Chat chat={chat} />);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7', label: 'Release prüfen' }, { command: 'tasks.summarize' }); });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'tasks.summarize', tool: 'tasks.summarize', args: { taskId: '7' } },
      label: '/Summarize @Release prüfen',
    });
  });

  it('fills command arguments from insertCommand(id, args) instead of asking for them', async () => {
    const chat = transport();
    render(<Chat chat={chat} />);
    act(() => { expect(composer.insertCommand('tasks.archive', { taskId: '9' })).toBe(true); });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toEqual({ commandId: 'tasks.archive', tool: 'tasks.archive', args: { taskId: '9' } });
  });

  it('looks a missing label up through resolve and refuses unknown entities and commands', async () => {
    render(<Chat chat={transport()} />);
    let results: boolean[] = [];
    await act(async () => {
      results = [
        await composer.insertMention({ type: 'task', id: '7' }),
        await composer.insertMention({ type: 'task', id: '404' }),
        await composer.insertMention({ type: 'team', id: 't1' }),
        composer.insertCommand('nope'),
      ];
    });
    expect(results).toEqual([true, false, false, false]);
    expect(screen.getByRole('textbox').querySelector('[data-mention-id="7"]')?.textContent).toContain('Release prüfen');
    expect(composer.hasCommand('tasks.summarize')).toBe(true);
    expect(composer.hasEntity('person')).toBe(false);
  });

  it('keeps requests until a composer is mounted', async () => {
    const chat = transport();
    const { rerender } = render(<Chat chat={chat} showInput={false} />);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7', label: 'Release prüfen' }); });
    rerender(<Chat chat={chat} />);
    await waitFor(() => expect(screen.getByRole('textbox').querySelector('[data-mention-id="7"]')).not.toBeNull());
  });

  it('replaces the draft unless append is set, and sets drafts with pills', async () => {
    render(<Chat chat={transport()} />);
    act(() => { composer.setDraft('Schau dir @release-prufen an', [{ id: '7', type: 'task', label: 'Release prüfen', prefix: '@', slug: 'release-prufen' }]); });
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll(PILL)).toHaveLength(1);
    await act(async () => { await composer.chatAbout({ type: 'team', id: 't1', label: 'Marketing' }, { append: true }); });
    expect(editor.querySelectorAll(PILL)).toHaveLength(2);
    await act(async () => { await composer.chatAbout({ type: 'team', id: 't2', label: 'Vertrieb' }); });
    expect(Array.from(editor.querySelectorAll<HTMLElement>(PILL)).map((pill) => pill.dataset.mentionId)).toEqual(['t2']);
    act(() => { composer.clear(); });
    expect(editor.querySelector('[data-mention-id]')).toBeNull();
  });

  it('opens the surrounding AssistantLayoutProvider without onOpenRequest', async () => {
    let layoutOpen = false;
    function LayoutProbe() {
      layoutOpen = useAssistantLayout().open;
      return null;
    }
    render(<AssistantLayoutProvider storageKey={null}><LayoutProbe /><Chat chat={transport()} /></AssistantLayoutProvider>);
    expect(layoutOpen).toBe(false);
    act(() => { composer.open(); });
    expect(layoutOpen).toBe(true);
  });

  it('labels a "chat about" entry in the chat language', () => {
    render(<Chat chat={transport()} />);
    expect(composer.chatAboutLabel).toBe('Chat about this');
    cleanup();
    function German() {
      const [chat] = useState(transport);
      const interactions = useMemo(() => ({ entities: [task], commands, locale: 'de' as const }), []);
      return <AiChatProvider transport={chat} chatInteractions={interactions} locale={{ chatAboutLabel: 'Mit KI besprechen' }}><AboutButton onComposer={(value) => { composer = value; }} /></AiChatProvider>;
    }
    render(<German />);
    expect(screen.getByRole('button', { name: 'Mit KI besprechen' })).toBeTruthy();
  });
});

describe('ChatInput', () => {
  it('is the pill composer when the chat has interactions, and a text field otherwise', () => {
    render(<Chat chat={transport()} />);
    expect(screen.getByRole('textbox').getAttribute('aria-autocomplete')).toBe('list');
    expect(document.querySelector('[data-component="mention-input"][data-mode="providers"]')).not.toBeNull();
    cleanup();
    render(<AiChatProvider transport={transport()}><ChatInput /></AiChatProvider>);
    expect(document.querySelector('textarea')).not.toBeNull();
  });
});
