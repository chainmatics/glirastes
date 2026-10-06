// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import type { ChatTransport } from '../../types.js';
import { MentionInput } from '../mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen', description: 'open' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
  actions: [
    { id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
    { id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
  ],
});

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
  defineChatCommand({ id: 'open.tasks', label: 'Open Tasks', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } }),
];

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let context: ChatContextValue | undefined;
function Probe() {
  context = useChatContext();
  return null;
}

function Composer({ chat }: { chat: ChatTransport }) {
  const interactions = useMemo(() => ({ entities: [task], commands }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe /><MentionInput /></AiChatProvider>;
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
// Picking a result moves the caret in an animation frame; let it land before the next test.
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
});

async function open(query: string) {
  const chat = transport();
  render(<Composer chat={chat} />);
  const editor = screen.getByRole('textbox');
  typeInto(editor, query);
  const listbox = await screen.findByRole('listbox', { name: 'Suggestions' });
  return { chat, editor, listbox };
}

describe('composer keyboard and ARIA for chat interactions', () => {
  it('exposes the suggestions as a listbox the editor controls and announces the count', async () => {
    const { editor, listbox } = await open('/open');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Open Overview', 'Open Tasks']);
    expect(editor.getAttribute('aria-autocomplete')).toBe('list');
    expect(editor.getAttribute('aria-controls')).toBe(listbox.id);
    expect(editor.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('2 suggestions');
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('runs a picked command without the model when it is sent alone', async () => {
    const { chat, editor } = await open('/open');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe('/open-overview '));
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toEqual({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } });
  });

  it('reaches entity actions with ArrowRight and runs them with Enter', async () => {
    const { chat, editor } = await open('@rel');
    const row = screen.getByRole('group', { name: 'Release prüfen' });
    expect(row.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(fireEvent.keyDown(editor, { key: 'ArrowRight' })).toBe(false);
    const complete = screen.getByRole('option', { name: 'Complete: Release prüfen' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(complete.id);
    expect(complete.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(editor.getAttribute('aria-activedescendant')).toBe(complete.id);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Complete @Release prüfen',
    });
    expect(editor.textContent).toBe('');
  });

  it('runs an entity action by mouse and leaves the caret keys alone where there is no action', async () => {
    const { chat, editor } = await open('@rep');
    expect(screen.queryByRole('group')).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(fireEvent.keyDown(editor, { key: 'ArrowLeft' })).toBe(true);
    fireEvent.click(screen.getByRole('option', { name: 'Open: Report schreiben' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation.args)
      .toEqual({ destination: '/tasks/:taskId', params: { taskId: '8' } });
  });

  it('inserts a picked entity as a structured reference the model receives', async () => {
    const { chat, editor } = await open('@rel');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-type="task"]')).toBeTruthy());
    expect(editor.querySelector('[data-mention-type="task"]')!.getAttribute('data-mention-prefix')).toBe('@');
    editor.append(document.createTextNode('ist fertig?'));
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(chat.sendMessage.mock.calls[0]![0].text).toBe('{{mention:task:7:Release prüfen}} ist fertig?');
  });

  it('adds an entity reference requested by the app through its definition', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    await act(async () => { await context!.mentionEntity('task', '7'); });
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(editor.querySelector('[data-mention-id="7"]')?.textContent).toContain('Release prüfen'));
  });
});
