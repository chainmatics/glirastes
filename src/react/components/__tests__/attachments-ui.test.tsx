// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';
import type { AttachmentButtonProps, AttachmentTrayProps, ChatAttachment, ChatComponents, ChatTransport } from '../../types.js';
import { AiChatPanel } from '../ai-chat-panel.js';
import { AttachmentButton, AttachmentTray } from '../attachments.js';
import * as reactEntry from '../../index.js';

type Transport = ChatTransport & { sendMessage: ReturnType<typeof vi.fn> };
const transport = (): Transport => ({
  messages: [], status: 'ready', error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
});

const image: ChatAttachment = { id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 8, url: 'data:image/png;base64,AA==', previewUrl: 'data:image/png;base64,AA==' };
const pdf: ChatAttachment = { id: 'a2', name: 'report.pdf', mediaType: 'application/pdf', size: 8, url: 'data:application/pdf;base64,AA==' };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('AttachmentTray', () => {
  it('lists images as thumbnails and other files by name, each removable', () => {
    const onRemove = vi.fn();
    render(<AiChatProvider transport={transport()}><AttachmentTray attachments={[image, pdf]} onRemove={onRemove} /></AiChatProvider>);
    const list = screen.getByRole('list', { name: 'Attachments' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByRole('img', { name: 'shot.png' }).getAttribute('src')).toBe(image.previewUrl);
    expect(within(list).getByText('report.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('a2');
  });

  it('announces errors and added files politely', () => {
    const { rerender } = render(<AiChatProvider transport={transport()}><AttachmentTray attachments={[]} onRemove={() => {}} /></AiChatProvider>);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    rerender(<AiChatProvider transport={transport()}><AttachmentTray attachments={[image]} onRemove={() => {}} /></AiChatProvider>);
    expect(status.textContent).toBe('shot.png attached');
    rerender(<AiChatProvider transport={transport()}><AttachmentTray attachments={[image]} onRemove={() => {}} error="Too big" /></AiChatProvider>);
    expect(status.textContent).toBe('Too big');
  });

  it('uses the German labels', () => {
    render(<AiChatProvider transport={transport()} locale={deChatLocale}><AttachmentTray attachments={[image]} onRemove={() => {}} /></AiChatProvider>);
    expect(screen.getByRole('button', { name: 'shot.png entfernen' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Anhänge' })).toBeTruthy();
  });
});

describe('AttachmentButton', () => {
  it('is a labelled button', () => {
    const onClick = vi.fn();
    render(<AiChatProvider transport={transport()}><AttachmentButton onClick={onClick} /></AiChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('default composer with attachments', () => {
  it('shows no attachment controls while attachments are off', () => {
    render(<AiChatProvider transport={transport()}><AiChatPanel /></AiChatProvider>);
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
  });

  it('attaches a pasted image and sends it', async () => {
    const chat = transport();
    const { container } = render(<AiChatProvider transport={chat} attachments><AiChatPanel /></AiChatProvider>);
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    const editor = screen.getByRole('textbox');
    const paste = createEvent.paste(editor, { clipboardData: { files: [new File([PNG], 'shot.png', { type: 'image/png' })], getData: () => '' } });
    await act(async () => { fireEvent(editor, paste); });
    await screen.findByRole('button', { name: 'Remove shot.png' });
    const send = container.querySelector('[data-action="send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '', files: [expect.objectContaining({ type: 'file', filename: 'shot.png' })],
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove shot.png' })).toBeNull());
  });

  it('renders the component slots', async () => {
    const components: ChatComponents = {
      AttachmentButton: ({ onClick }: AttachmentButtonProps) => <button type="button" onClick={onClick}>clip</button>,
      AttachmentTray: ({ attachments }: AttachmentTrayProps) => <p data-testid="tray">{attachments.length}</p>,
    };
    render(<AiChatProvider transport={transport()} attachments components={components}><AiChatPanel /></AiChatProvider>);
    expect(screen.getByRole('button', { name: 'clip' })).toBeTruthy();
    expect(screen.getByTestId('tray').textContent).toBe('0');
  });
});

describe('public entry', () => {
  it('exports the attachment components', () => {
    expect(reactEntry.AttachmentTray).toBe(AttachmentTray);
    expect(reactEntry.AttachmentButton).toBe(AttachmentButton);
  });
});
