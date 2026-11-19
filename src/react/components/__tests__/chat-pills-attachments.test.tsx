// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { useChatComposerInput } from '../../hooks/use-chat-composer-input.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatComposerInput, ChatTransport } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: () => [{ id: '7', label: 'Release prüfen' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
});
const commands = [
  defineChatCommand({
    id: 'tasks.summarize',
    label: 'Summarize',
    args: [{ name: 'taskId', label: 'Task', required: true, entity: 'task' }],
    run: { kind: 'tool', tool: 'tasks.summarize' },
  }),
];

const PILL = '[data-component="mention-chip"]';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => new File([PNG], 'shot.png', { type: 'image/png' });
const pngPart = { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`, filename: 'shot.png',
  providerMetadata: { glirastes: { attachmentId: expect.stringMatching(/^att_/) } } };

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let composer: ChatComposer;
let input: ChatComposerInput | undefined;

function Probe() {
  composer = useChatComposer();
  return null;
}

function Chat({ chat, children }: { chat: ChatTransport; children: ReactNode }) {
  const interactions = useMemo(() => ({ entities: [task], commands }), []);
  return (
    <AiChatProvider transport={chat} chatInteractions={interactions} attachments>
      <Probe />
      {children}
    </AiChatProvider>
  );
}

/** A custom composer that only uses `useChatComposerInput`, no `useChatComposerTarget`. */
function Custom() {
  const current = useChatComposerInput();
  input = current;
  return (
    <form onSubmit={(event) => { event.preventDefault(); current.submit(); }}>
      <input data-testid="picker" {...current.attachmentInputProps} />
      <RichMentionInput ref={current.inputRef} {...current.inputProps} />
      <button type="submit" disabled={!current.canSend}>go</button>
    </form>
  );
}

function pickFiles(picker: HTMLInputElement, files: File[]) {
  Object.defineProperty(picker, 'files', { configurable: true, value: files });
  fireEvent.change(picker);
}

function typeAtEnd(editor: HTMLElement, text: string) {
  editor.appendChild(document.createTextNode(text));
  const range = document.createRange();
  range.setStartAfter(editor.lastChild!);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
  input = undefined;
});

describe('pills and attachments together', () => {
  it('sends an entity pill, text and an attachment from the default composer in one message', async () => {
    const chat = transport();
    const { container } = render(<Chat chat={chat}><ChatInput /></Chat>);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7', label: 'Release prüfen' }, { text: 'was fehlt hier?' }); });
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { pickFiles(picker, [png()]); });
    await screen.findByRole('button', { name: 'Remove shot.png' });
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll(PILL)).toHaveLength(1);

    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const sent = chat.sendMessage.mock.calls[0]![0] as { text: string; files?: unknown[] };
    expect(sent.files).toEqual([pngPart]);
    expect(sent.text).toContain('was fehlt hier?');
    expect(sent.text).toContain('Release prüfen');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove shot.png' })).toBeNull());
    expect(editor.querySelector(PILL)).toBeNull();
  });

  it('lets useChatComposer reach a custom composer built on useChatComposerInput', async () => {
    const chat = transport();
    render(<Chat chat={chat}><Custom /></Chat>);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7' }); });
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(editor.querySelector('[data-mention-id="7"]')?.textContent).toContain('Release prüfen'));
    expect(input!.value).toContain('@');
    expect(input!.canSend).toBe(true);

    await act(async () => { await input!.addFiles([png()]); });
    typeAtEnd(editor, ' bitte prüfen');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const sent = chat.sendMessage.mock.calls[0]![0] as { text: string; files?: unknown[] };
    expect(sent.files).toEqual([pngPart]);
    expect(sent.text).toContain('Release prüfen');
    await waitFor(() => expect(input!.attachments).toHaveLength(0));
  });

  it('removes the pill before the attachment on Backspace', async () => {
    render(<Chat chat={transport()}><Custom /></Chat>);
    await act(async () => { await composer.insertMention({ type: 'task', id: '7', label: 'Release prüfen' }); });
    await act(async () => { await input!.addFiles([png()]); });
    const editor = screen.getByRole('textbox');
    const pill = editor.querySelector<HTMLElement>('[data-mention-id]')!;
    const range = document.createRange();
    range.setStartAfter(pill);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(editor.querySelector(PILL)).toBeNull();
    expect(input!.attachments).toHaveLength(1);

    fireEvent.keyDown(editor, { key: 'Backspace' });
    await waitFor(() => expect(input!.attachments).toHaveLength(0));
  });

  it('refuses a direct command pill with an attachment and keeps pills and files', async () => {
    const chat = transport();
    render(<Chat chat={chat}><Custom /></Chat>);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7', label: 'Release prüfen' }, { command: 'tasks.summarize' }); });
    await act(async () => { await input!.addFiles([png()]); });
    act(() => { expect(input!.submit()).toBe(false); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(input!.attachmentError).toBe('Commands cannot carry attachments. Remove them or write a message.');
    expect(screen.getByRole('textbox').querySelectorAll(PILL)).toHaveLength(2);
    expect(input!.attachments).toHaveLength(1);
  });
});
