// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { RichMentionInput } from '../../components/rich-mention-input.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import type { ChatComposer, ChatTransport, UseChatComposerOptions } from '../../types.js';
import { useChatComposer } from '../use-chat-composer.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
  actions: [
    { id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
  ],
});

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
  defineChatCommand({
    id: 'tasks.rename', label: 'Rename', args: [{ name: 'title', label: 'Title', required: true }],
    run: { kind: 'tool', tool: 'tasks.rename' },
  }),
];

type Transport = ChatTransport & { sendMessage: ReturnType<typeof vi.fn> };

function transport(withApproval = false): Transport {
  return {
    messages: withApproval
      ? [{
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'tool-tasks.update', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'approval-1' } } as never],
      }]
      : [],
    status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let context: ChatContextValue | undefined;
let composer: ChatComposer | undefined;

function Custom({ options }: { options?: UseChatComposerOptions }) {
  context = useChatContext();
  const current = useChatComposer(options);
  composer = current;
  return (
    <form onSubmit={(event) => { event.preventDefault(); current.submit(); }}>
      {current.argumentsForm}
      <RichMentionInput ref={current.inputRef} {...current.inputProps} />
      <button type="button" onClick={() => current.appendText('diktiert')}>mic</button>
      <button type="submit" disabled={!current.canSend}>go</button>
    </form>
  );
}

function App({ chat, options }: { chat: ChatTransport; options?: UseChatComposerOptions }) {
  const interactions = useMemo(() => ({ entities: [task], commands }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Custom options={options} /></AiChatProvider>;
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

function invocation(chat: Transport, call = 0) {
  return parseChatCommandMessage(chat.sendMessage.mock.calls[call]![0].text as string)?.invocation;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
  context = undefined;
  composer = undefined;
});

async function pick(query: string) {
  const editor = screen.getByRole('textbox');
  typeInto(editor, query);
  await screen.findByRole('listbox');
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return editor;
}

describe('useChatComposer', () => {
  it('runs a picked command without the model from a custom composer', async () => {
    const chat = transport();
    render(<App chat={chat} />);
    const editor = await pick('/open');
    await waitFor(() => expect(screen.getByRole('button', { name: 'go' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(invocation(chat)).toEqual({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } });
    expect(editor.textContent).toBe('');
  });

  it('runs an entity action picked in a custom composer', async () => {
    const chat = transport();
    render(<App chat={chat} />);
    typeInto(screen.getByRole('textbox'), '@rel');
    fireEvent.click(await screen.findByRole('option', { name: 'Complete: Release prüfen' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(invocation(chat)).toEqual({ commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } });
  });

  it('shows the argument form for a command that needs values and sends after it', async () => {
    const chat = transport();
    const { container } = render(<App chat={chat} />);
    await pick('/ren');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(container.querySelector('[data-component="command-arguments"]')).not.toBeNull());
    expect(chat.sendMessage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title *' }), { target: { value: 'Neu' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Details for Rename' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(invocation(chat)).toEqual({ commandId: 'tasks.rename', tool: 'tasks.rename', args: { title: 'Neu' } });
    expect(container.querySelector('[data-component="command-arguments"]')).toBeNull();
  });

  it('keeps a picked command when text is appended', async () => {
    render(<App chat={transport()} />);
    const editor = await pick('/open');
    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    expect(composer!.inputRef.current!.getMentions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'command', id: 'open.overview' })]),
    );
    expect(editor.textContent?.trimEnd().endsWith('diktiert')).toBe(true);
  });

  it('inserts references requested through mentionEntity', async () => {
    const { container } = render(<App chat={transport()} />);
    await act(async () => { await context!.mentionEntity('task', '7'); });
    await waitFor(() => expect(container.querySelector('[data-mention-id="7"]')).not.toBeNull());
  });

  it('puts the initial text into the editor once', async () => {
    const chat = transport();
    const { rerender } = render(<App chat={chat} options={{ initialValue: 'Hallo' }} />);
    const editor = screen.getByRole('textbox');
    expect(editor.textContent).toBe('Hallo');
    await waitFor(() => expect(screen.getByRole('button', { name: 'go' })).toHaveProperty('disabled', false));
    act(() => { composer!.setText(''); });
    rerender(<App chat={chat} options={{ initialValue: 'Hallo' }} />);
    expect(editor.textContent).toBe('');
  });

  it('reports whether the message was taken', async () => {
    const chat = transport(true);
    render(<App chat={chat} />);
    act(() => { composer!.setText('Hallo'); });
    let taken = true;
    act(() => { taken = composer!.submit(); });
    expect(taken).toBe(false);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').textContent).toBe('Hallo');
  });
});
