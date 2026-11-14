// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichMentionInput } from '../../components/rich-mention-input.js';
import { defineChatCommand } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatAttachmentOptions, ChatComposerInput, ChatMessage, ChatTransport, UseChatComposerInputOptions } from '../../types.js';
import { useChatComposerInput } from '../use-chat-composer-input.js';

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
];

type Transport = ChatTransport & { sendMessage: ReturnType<typeof vi.fn> };

function transport(messages: ChatMessage[] = []): Transport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let composer: ChatComposerInput | undefined;

function Custom({ options }: { options?: UseChatComposerInputOptions }) {
  const current = useChatComposerInput(options);
  composer = current;
  return (
    <form onSubmit={(event) => { event.preventDefault(); current.submit(); }}>
      <input data-testid="picker" {...current.attachmentInputProps} />
      <RichMentionInput ref={current.inputRef} {...current.inputProps} />
      <button type="submit" disabled={!current.canSend}>go</button>
    </form>
  );
}

function App({ chat, attachments = true, options }: {
  chat: ChatTransport;
  attachments?: boolean | ChatAttachmentOptions;
  options?: UseChatComposerInputOptions;
}) {
  const interactions = useMemo(() => ({ commands }), []);
  return (
    <AiChatProvider transport={chat} chatInteractions={interactions} attachments={attachments}>
      <Custom options={options} />
    </AiChatProvider>
  );
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (name = 'shot.png') => new File([PNG], name, { type: 'image/png' });
const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;

async function attach(...files: File[]) {
  await act(async () => { await composer!.addFiles(files); });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
  composer = undefined;
});

describe('useChatComposerInput attachments', () => {
  it('sends attachments without text and clears them afterwards', async () => {
    const chat = transport();
    render(<App chat={chat} />);
    expect(composer!.canSend).toBe(false);
    await attach(png());
    expect(composer!.attachments).toHaveLength(1);
    expect(composer!.canSend).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '',
      files: [{ type: 'file', mediaType: 'image/png', url: dataUrl, filename: 'shot.png' }],
    });
    await waitFor(() => expect(composer!.attachments).toHaveLength(0));
  });

  it('sends text without a files key when nothing is attached', async () => {
    const chat = transport();
    render(<App chat={chat} />);
    act(() => composer!.setText('Hallo'));
    act(() => { composer!.submit(); });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Hallo' }));
  });

  it('keeps the attachments when the send is refused', async () => {
    const chat = transport([{
      id: 'assistant-1', role: 'assistant',
      parts: [{ type: 'tool-tasks.update', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'approval-1' } } as never],
    }]);
    render(<App chat={chat} />);
    await waitFor(() => expect(composer).toBeDefined());
    await attach(png());
    act(() => { expect(composer!.submit()).toBe(false); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(composer!.attachments).toHaveLength(1);
  });

  it('refuses a direct command with attachments and keeps text and files', async () => {
    const chat = transport();
    render(<App chat={chat} />);
    const editor = screen.getByRole('textbox');
    editor.textContent = '/open';
    const range = document.createRange();
    range.setStart(editor.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.input(editor);
    await screen.findByRole('listbox');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await attach(png());
    act(() => { expect(composer!.submit()).toBe(false); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(composer!.attachments).toHaveLength(1);
    expect(composer!.attachmentError).toBe('Commands cannot carry attachments. Remove them or write a message.');
    expect(editor.textContent).not.toBe('');
  });

  it('keeps the editor text when Enter is refused', async () => {
    const chat = transport([{
      id: 'assistant-1', role: 'assistant',
      parts: [{ type: 'tool-tasks.update', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'approval-1' } } as never],
    }]);
    render(<App chat={chat} />);
    const editor = screen.getByRole('textbox');
    editor.textContent = 'Bitte prüfen';
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Bitte prüfen');
  });

  it('reports a refused file type and keeps the accepted ones', async () => {
    render(<App chat={transport()} />);
    await attach(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), png());
    expect(composer!.attachments.map((attachment) => attachment.name)).toEqual(['shot.png']);
    expect(composer!.attachmentError).toBe('x.svg is not a supported file type.');
  });

  it('reports a file over the limit with the limit', async () => {
    render(<App chat={transport()} attachments={{ maxFileBytes: 4 }} />);
    await attach(png());
    expect(composer!.attachments).toHaveLength(0);
    expect(composer!.attachmentError).toBe('shot.png is larger than 4 B.');
  });

  it('removes an attachment and the last one on backspace in an empty editor', async () => {
    render(<App chat={transport()} />);
    await attach(png('a.png'), png('b.png'));
    act(() => composer!.removeAttachment(composer!.attachments[0]!.id));
    expect(composer!.attachments.map((attachment) => attachment.name)).toEqual(['b.png']);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
    expect(composer!.attachments).toHaveLength(0);
  });

  it('does nothing while attachments are off', async () => {
    render(<App chat={transport()} attachments={false} />);
    expect(composer!.attachmentsEnabled).toBe(false);
    await attach(png());
    expect(composer!.attachments).toHaveLength(0);
    expect(composer!.inputProps.onFiles).toBeUndefined();
  });

  it('wires a hidden file input for the picker', async () => {
    render(<App chat={transport()} />);
    const picker = screen.getByTestId('picker') as HTMLInputElement;
    expect(picker.type).toBe('file');
    expect(picker.multiple).toBe(true);
    expect(picker.accept).toBe('image/png,image/jpeg,image/webp,image/gif,application/pdf');
    const click = vi.spyOn(picker, 'click');
    act(() => composer!.openFilePicker());
    expect(click).toHaveBeenCalledOnce();
    Object.defineProperty(picker, 'files', { value: [png()], configurable: true });
    await act(async () => { fireEvent.change(picker); });
    await waitFor(() => expect(composer!.attachments).toHaveLength(1));
  });

  it('adds pasted files through inputProps.onFiles', async () => {
    render(<App chat={transport()} />);
    await act(async () => { composer!.inputProps.onFiles!([png()]); });
    await waitFor(() => expect(composer!.attachments).toHaveLength(1));
  });

  it('hands the files to a custom onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<App chat={transport()} options={{ onSubmit }} />);
    await attach(png());
    act(() => { composer!.submit(); });
    expect(onSubmit).toHaveBeenCalledWith('', [], [expect.objectContaining({ type: 'file', filename: 'shot.png' })]);
  });

  it('does not serialize the whole history to compare it on send', async () => {
    const big = `data:image/png;base64,${'A'.repeat(200_000)}`;
    const chat = transport([{ id: 'u0', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: big, filename: 'big.png' }] }]);
    render(<App chat={chat} />);
    const stringify = vi.spyOn(JSON, 'stringify');
    act(() => composer!.setText('Hallo'));
    act(() => { composer!.submit(); });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalled());
    expect(stringify.mock.calls.some(([value]) => value === chat.messages)).toBe(false);
  });
});
