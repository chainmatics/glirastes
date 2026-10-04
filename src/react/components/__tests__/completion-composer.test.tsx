// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatCompletionProvider,
  ChatTransport,
  MentionData,
  UiToolCommandSource,
} from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { createUiToolCommandProvider } from '../../completions/ui-tool-command-provider.js';
import { AiChatPanel } from '../ai-chat-panel.js';
import { MentionInput } from '../mention-input.js';

// The real addon records from the microphone. The composer only needs its
// `onTranscript` contract, so a button stands in for finished dictations.
const dictation = vi.hoisted(() => ({ next: 'und weiter' }));
vi.mock('../voice-input-addon.js', () => ({
  VoiceInputAddon: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button type="button" data-testid="dictate" onClick={() => onTranscript(dictation.next)}>
      dictate
    </button>
  ),
}));

function transport(): ChatTransport {
  return {
    messages: [],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: ({ context }) => (context.roles?.includes('member')
    ? [{ id: '42', type: 'user', label: 'Alice Doe' }]
    : []),
};

const NO_TOOLS: ReadonlyArray<UiToolCommandSource> = [];
const NO_PROVIDERS: ReadonlyArray<ChatCompletionProvider> = [];

const NAVIGATE_ADMIN: UiToolCommandSource = {
  definitionId: 'ui.navigate',
  commandId: 'ui.navigate.admin',
  label: 'Administration öffnen',
  args: { destination: 'admin' },
};

const NAVIGATE_ADMIN_REFERENCE = 'tool: ui.navigate, args: {"destination":"admin"}';
const NAVIGATE_ADMIN_MARKER = '{{mention:command:ui.navigate.admin:Administration öffnen}}';

interface ComposerProps {
  chat: ChatTransport;
  extraTools?: ReadonlyArray<UiToolCommandSource>;
  extraProviders?: ReadonlyArray<ChatCompletionProvider>;
  voice?: boolean;
  panel?: boolean;
  onBeforeSend?: (message: string, mentions: MentionData[]) => string;
  onCompletionProviderError?: (providerId: string, error: unknown) => void;
}

function Composer({
  chat,
  extraTools = NO_TOOLS,
  extraProviders = NO_PROVIDERS,
  voice,
  panel,
  onBeforeSend,
  onCompletionProviderError,
}: ComposerProps) {
  const providers = useMemo(() => [
    createUiToolCommandProvider({ tools: [
      { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen' },
      { definitionId: 'ui.filter.done', label: 'Erledigte filtern' },
      ...extraTools,
    ] }),
    people,
    ...extraProviders,
  ], [extraTools, extraProviders]);
  const context = useMemo(() => ({ roles: ['member'] }), []);
  const voiceConfig = useMemo(() => (voice ? { enabled: true } : undefined), [voice]);
  return (
    <AiChatProvider
      transport={chat}
      completionProviders={providers}
      completionContext={context}
      voice={voiceConfig}
      onBeforeSend={onBeforeSend}
      onCompletionProviderError={onCompletionProviderError}
    >
      {panel ? <AiChatPanel /> : <MentionInput />}
    </AiChatProvider>
  );
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

/** Picks the first entry of the open list by keyboard and waits for the command token. */
async function pickFirstCommand(editor: HTMLElement, query: string, label: string, token: string) {
  typeInto(editor, query);
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(editor.textContent).toBe(`${token} `));
}

function sentText(chat: ChatTransport): string {
  const calls = vi.mocked(chat.sendMessage).mock.calls;
  expect(calls).toHaveLength(1);
  return (calls[0]![0] as { text: string }).text;
}

describe('composer with completion providers', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    // insertMention restores the caret in a rAF; flush it before unmounting.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    cleanup();
  });

  it('selects a / command by keyboard and sends its stable definition id', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '/er');
    await waitFor(() => expect(screen.getByText('Erledigte filtern')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.textContent).toBe('/erledigte-filtern '));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '{{mention:command:ui.filter.done:Erledigte filtern}}',
    }));
  });

  it('navigates @ results with arrow keys and keeps the user id', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Frag @al');
    await waitFor(() => expect(screen.getByText('Alice Doe')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Tab' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="42"]')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: 'Frag {{mention:user:42:Alice Doe}}',
    }));
  });

  it('closes the list with Escape without sending', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });
    typeInto(editor, '/ub');
    await waitFor(() => expect(screen.getByText('Übersicht öffnen')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(document.querySelector('[data-component="mention-dropdown"]')).toBeNull();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the definition id and arguments of an args-bearing command next to its marker', async () => {
    const chat = transport();
    render(<Composer chat={chat} extraTools={[NAVIGATE_ADMIN]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    await pickFirstCommand(editor, '/adm', 'Administration öffnen', '/administration-offnen');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = sentText(chat);
    expect(text).toContain(NAVIGATE_ADMIN_REFERENCE);
    expect(text).toContain(NAVIGATE_ADMIN_MARKER);
  });

  it('sends the send button message with the structured mentions of the editor', async () => {
    const chat = transport();
    render(<Composer chat={chat} extraTools={[NAVIGATE_ADMIN]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    await pickFirstCommand(editor, '/adm', 'Administration öffnen', '/administration-offnen');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = sentText(chat);
    expect(text).toContain(NAVIGATE_ADMIN_REFERENCE);
    expect(text).toContain(NAVIGATE_ADMIN_MARKER);
    expect(editor.textContent).toBe('');
  });

  it('does not send a command whose token was deleted from the text', async () => {
    const chat = transport();
    render(<Composer chat={chat} extraTools={[NAVIGATE_ADMIN]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    await pickFirstCommand(editor, '/adm', 'Administration öffnen', '/administration-offnen');
    typeInto(editor, 'Doch lieber nur Text');
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = sentText(chat);
    expect(text).toBe('Doch lieber nur Text');
    expect(text).not.toContain('ui.navigate');
  });

  it('keeps the tool reference of a picked command after one dictation', async () => {
    const chat = transport();
    render(<Composer chat={chat} extraTools={[NAVIGATE_ADMIN]} voice />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    await pickFirstCommand(editor, '/adm', 'Administration öffnen', '/administration-offnen');
    dictation.next = 'und dann';
    act(() => { fireEvent.click(screen.getByTestId('dictate')); });
    await waitFor(() => expect(editor.textContent).toContain('und dann'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = sentText(chat);
    expect(text).toContain(NAVIGATE_ADMIN_REFERENCE);
    expect(text).toContain(NAVIGATE_ADMIN_MARKER);
    expect(text).toContain('und dann');
  });

  it('keeps the tool reference of a picked command over two dictations', async () => {
    const chat = transport();
    render(<Composer chat={chat} extraTools={[NAVIGATE_ADMIN]} voice />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    await pickFirstCommand(editor, '/adm', 'Administration öffnen', '/administration-offnen');
    dictation.next = 'und dann';
    act(() => { fireEvent.click(screen.getByTestId('dictate')); });
    await waitFor(() => expect(editor.textContent).toContain('und dann'));
    // The first dictation turned the command into a chip; the second one reads it back from there.
    expect(editor.querySelector('[data-mention-definition-id="ui.navigate"]')).toBeTruthy();
    dictation.next = 'noch mehr';
    act(() => { fireEvent.click(screen.getByTestId('dictate')); });
    await waitFor(() => expect(editor.textContent).toContain('noch mehr'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = sentText(chat);
    expect(text).toContain(NAVIGATE_ADMIN_REFERENCE);
    expect(text).toContain(NAVIGATE_ADMIN_MARKER);
    expect(text).toContain('und dann noch mehr');
    expect(text.match(/\{\{mention:/g)).toHaveLength(1);
  });

  it('offers the mention composer in the panel when only completion providers are set', async () => {
    const chat = transport();
    render(<Composer chat={chat} panel />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '/er');
    await waitFor(() => expect(screen.getByText('Erledigte filtern')).toBeTruthy());
    expect(document.querySelector('[data-component="mention-input"][data-mode="providers"]')).toBeTruthy();
  });

  it('uses an explicit slug for the token and keeps the id in the marker', async () => {
    const chat = transport();
    const tickets: ChatCompletionProvider = {
      id: 'tickets',
      trigger: '/',
      search: () => [{ id: 'T-7', type: 'task', label: 'Ticket sieben', slug: 'T-7' }],
    };
    render(<Composer chat={chat} extraProviders={[tickets]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '/tick');
    await waitFor(() => expect(screen.getByText('Ticket sieben')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Tab' });
    await waitFor(() => expect(editor.querySelector('[data-mention-slug="t-7"]')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '{{mention:task:T-7:Ticket sieben}}',
    }));
  });

  it('lists results of different providers that share an id without key collisions', async () => {
    const chat = transport();
    const teams: ChatCompletionProvider = {
      id: 'teams',
      trigger: '@',
      search: () => [{ id: '42', type: 'team', label: 'Alpha Team' }],
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<Composer chat={chat} extraProviders={[teams]} />);
      const editor = screen.getByRole('textbox', { name: 'Type a message...' });

      typeInto(editor, 'Frag @a');
      await waitFor(() => expect(screen.getByText('Alpha Team')).toBeTruthy());
      expect(screen.getByText('Alice Doe')).toBeTruthy();
      expect(errors.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      errors.mockRestore();
    }
  });

  it('hands the structured mentions of the composer to onBeforeSend', async () => {
    const chat = transport();
    const onBeforeSend = vi.fn<(message: string, mentions: MentionData[]) => string>(
      (message) => message,
    );
    render(<Composer chat={chat} onBeforeSend={onBeforeSend} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Frag @al');
    await waitFor(() => expect(screen.getByText('Alice Doe')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Tab' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="42"]')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(onBeforeSend).toHaveBeenCalledTimes(1));
    expect(onBeforeSend.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ id: '42', type: 'user', label: 'Alice Doe' }),
    ]);
  });

  it('reports a failing provider and still lists the others', async () => {
    const chat = transport();
    const broken: ChatCompletionProvider = {
      id: 'broken',
      trigger: '@',
      search: () => { throw new Error('backend down'); },
    };
    const onCompletionProviderError = vi.fn();
    render(
      <Composer
        chat={chat}
        extraProviders={[broken]}
        onCompletionProviderError={onCompletionProviderError}
      />,
    );
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Frag @al');
    await waitFor(() => expect(screen.getByText('Alice Doe')).toBeTruthy());
    expect(onCompletionProviderError).toHaveBeenCalledWith('broken', expect.any(Error));
  });
});
