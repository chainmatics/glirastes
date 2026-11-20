// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type {
  AiChatProviderConfig,
  ChatCompletionProvider,
  ChatComposerInputControls,
  ChatTransport,
  ChatTriggerDefinition,
  ComposerConfig,
} from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { MentionInput } from '../mention-input.js';

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: () => [{ id: '7', label: 'Müller' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Müller' } : undefined),
});

const templates: ChatCompletionProvider = {
  id: 'templates',
  trigger: '/',
  search: () => [
    { id: 'summary', type: 'template', label: 'Summarize', select: 'text', insertText: 'Please summarize this ticket.' },
    { id: 'reply', type: 'template', label: 'Draft a reply', select: 'text', insertText: 'Draft a reply.' },
  ],
};
const others: ChatCompletionProvider = {
  id: 'others',
  trigger: '/',
  search: () => [{ id: 'other', type: 'template', label: 'Other', select: 'text' }],
};

const TRIGGERS: ReadonlyArray<ChatTriggerDefinition> = [{ char: '@', label: 'Mention' }];

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

interface SetupProps {
  composer?: ComposerConfig;
  attachments?: boolean;
  interactions?: boolean;
  language?: string;
  children: ReactNode;
}

function Setup({ composer, attachments = true, interactions = true, language, children }: SetupProps) {
  const chatInteractions = useMemo(() => ({ entities: [person] }), []);
  const providers = useMemo(() => [templates, others], []);
  return (
    <AiChatProvider
      transport={transport()}
      {...(interactions ? { chatInteractions, completionProviders: providers, triggers: TRIGGERS } : {})}
      attachments={attachments}
      {...(language ? { language } : {})}
      {...(composer ? { composer } : {})}
    >
      {children}
    </AiChatProvider>
  );
}

const plusAtStart: ComposerConfig = { toolbar: { start: ['plus'], end: ['send'] } };

function plusButton() {
  return screen.getByRole('button', { name: 'More actions' });
}

function menuItems() {
  return screen.getAllByRole('menuitem');
}

function openMenu() {
  fireEvent.click(plusButton());
  return screen.getByRole('menu');
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('composer plus menu', () => {
  it('renders nothing without plus in the toolbar', () => {
    const { container } = render(<Setup><MentionInput /></Setup>);
    expect(container.querySelector('[data-component="composer-plus-menu"]')).toBeNull();
  });

  it('is a menu button whose default rows are attach and one row per trigger', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    const button = plusButton();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const menu = openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    expect(menuItems().map((item) => item.textContent)).toEqual(['Attach file', 'Mention', '/']);
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it('moves with the arrow keys (wrapping), Home and End', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    const menu = openMenu();
    const [attach, mention, command] = menuItems();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(mention);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(command);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(attach);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(command);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(attach);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(command);
  });

  it('opens on the last row with ArrowUp on the button', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    fireEvent.keyDown(plusButton(), { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('/');
  });

  it('closes on Escape and gives the focus back to the button', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(plusButton());
    expect(plusButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when a turn starts streaming, so the focus never lands on the disabled button', () => {
    function Streaming({ status }: { status: ChatTransport['status'] }) {
      const chat = useMemo(() => transport(), []);
      const current = useMemo(() => ({ ...chat, status }), [chat, status]);
      return (
        <AiChatProvider transport={current} attachments composer={plusAtStart}>
          <MentionInput />
        </AiChatProvider>
      );
    }
    const { rerender } = render(<Streaming status="ready" />);
    openMenu();
    rerender(<Streaming status="streaming" />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(plusButton().getAttribute('aria-expanded')).toBe('false');
    rerender(<Streaming status="ready" />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Tab', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a pointer press outside, not on one inside', () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    openMenu();
    fireEvent.pointerDown(menuItems()[1]!);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the file picker from the attach row, also without the attach toolbar item', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const { container } = render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    // The hidden file input comes with the menu when the attach item is not in the toolbar.
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    openMenu();
    const attach = screen.getByRole('menuitem', { name: 'Attach file' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toBe(container.querySelector('input[type="file"]'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(attach.isConnected).toBe(false);
  });

  it('keeps a single file input when the attach item is in the toolbar too', () => {
    const { container } = render(
      <Setup composer={{ toolbar: { start: ['attach', 'plus'], end: ['send'] } }}><MentionInput /></Setup>,
    );
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('has no attach row when attachments are off', () => {
    render(<Setup attachments={false} composer={plusAtStart}><MentionInput /></Setup>);
    openMenu();
    expect(menuItems().map((item) => item.textContent)).toEqual(['Mention', '/']);
  });

  it('opens the @ list from the mention row with the focus in the editor', async () => {
    render(<Setup composer={plusAtStart}><MentionInput /></Setup>);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention' }));
    const editor = screen.getByRole('textbox');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor.textContent).toBe('@');
    expect(document.activeElement).toBe(editor);
    await waitFor(() => expect(screen.getByRole('option', { name: /Müller/ })).toBeTruthy());
    expect(document.activeElement).toBe(editor);
  });

  it('runs a custom item with the controls and skips hidden and render items', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSelect = vi.fn((controls: ChatComposerInputControls) => controls.appendText('Hallo'));
    const composer: ComposerConfig = {
      toolbar: { start: ['plus'], end: ['send'] },
      items: {
        greet: { label: 'Greet', icon: <span>G</span>, onSelect },
        gone: { label: 'Gone', hidden: () => true },
        drawn: { label: 'Drawn', render: () => <span>drawn</span> },
      },
      plusMenu: { items: ['greet', 'gone', 'drawn', 'nope-unknown-plus-id'] },
    };
    const { rerender } = render(<Setup composer={composer}><MentionInput /></Setup>);
    openMenu();
    expect(menuItems().map((item) => item.textContent)).toEqual(['GGreet']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Greet' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox').textContent).toBe('Hallo');
    rerender(<Setup composer={composer}><MentionInput className="x" /></Setup>);
    openMenu();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('cannot be a menu row'))).toHaveLength(1);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('composer.plusMenu: an id is neither'))).toHaveLength(1);
    // Fixed text only: no config value in the console.
    expect(warn.mock.calls.some((call) => call.join(' ').includes('nope-unknown-plus-id'))).toBe(false);
  });

  it('lists entries of a source section and inserts the insertText of a text entry', async () => {
    const composer: ComposerConfig = {
      toolbar: { start: ['plus'], end: ['send'] },
      plusMenu: { items: ['trigger:@'], source: { trigger: '/', source: 'templates', label: 'Templates', limit: 1 } },
    };
    render(<Setup composer={composer}><MentionInput /></Setup>);
    openMenu();
    const section = await screen.findByRole('group', { name: 'Templates' });
    expect(menuItems().map((item) => item.textContent)).toEqual(['Mention', 'Summarize']);
    expect(section.contains(screen.getByRole('menuitem', { name: 'Summarize' }))).toBe(true);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: ' ' });
    const editor = screen.getByRole('textbox');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor.textContent).toBe('Please summarize this ticket.');
    expect(document.activeElement).toBe(editor);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('inserts a chip entry of the source section at the caret', async () => {
    const composer: ComposerConfig = {
      toolbar: { start: ['plus'], end: ['send'] },
      plusMenu: { items: [], source: { trigger: '@' } },
    };
    render(<Setup composer={composer}><MentionInput /></Setup>);
    // The menu shows once the source rows are in (no empty box while it searches).
    fireEvent.click(plusButton());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Müller' }));
    const editor = screen.getByRole('textbox');
    const chip = editor.querySelector('[data-component="mention-chip"]');
    expect(chip?.textContent).toContain('Müller');
    expect(editor.textContent).not.toContain('@@');
    expect(document.activeElement).toBe(editor);
  });

  it('opens a sub-list from a source entry through onCompletionSelect, which closes away untouched', async () => {
    const composer: ComposerConfig = {
      toolbar: { start: ['plus'], end: ['send'] },
      plusMenu: { items: [], source: { trigger: '/', source: 'others' } },
    };
    const groups: ChatCompletionProvider = {
      id: 'others',
      trigger: '/',
      search: () => [{ id: 'all', type: 'group', label: 'All templates' }],
    };
    const onCompletionSelect: NonNullable<AiChatProviderConfig['onCompletionSelect']> = (item, { trigger, controls }) => {
      if (item.id !== 'all') return undefined;
      controls.openCompletion({ trigger, source: 'templates' });
      return true;
    };
    function WithGroups() {
      const providers = useMemo(() => [templates, groups], []);
      return (
        <AiChatProvider transport={transport()} completionProviders={providers} composer={composer} onCompletionSelect={onCompletionSelect}>
          <MentionInput />
        </AiChatProvider>
      );
    }
    render(<WithGroups />);
    // The menu shows once the source rows are in (no empty box while it searches).
    fireEvent.click(plusButton());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'All templates' }));
    const editor = screen.getByRole('textbox');
    expect(editor.textContent).toBe('/');
    expect(document.activeElement).toBe(editor);
    await waitFor(() => expect(screen.getByRole('option', { name: /Summarize/ })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /All templates/ })).toBeNull();
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('');
  });

  it('hides the source section when it finds nothing', async () => {
    const composer: ComposerConfig = {
      toolbar: { start: ['plus'], end: ['send'] },
      plusMenu: { items: ['trigger:@'], source: { trigger: '/', source: 'missing-provider', label: 'Templates' } },
    };
    render(<Setup composer={composer}><MentionInput /></Setup>);
    openMenu();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('group')).toBeNull();
    expect(menuItems()).toHaveLength(1);
  });

  it('uses the German labels of locale-de', () => {
    render(<Setup language="de" composer={plusAtStart}><MentionInput /></Setup>);
    const button = screen.getByRole('button', { name: 'Mehr Aktionen' });
    fireEvent.click(button);
    expect(screen.getByRole('menuitem', { name: 'Datei anhängen' })).toBeTruthy();
  });

  it('offers custom items in the plain input and leaves out triggers', () => {
    render(
      <Setup interactions={false} attachments={false} composer={{ toolbar: { end: ['plus', 'send'] }, items: { greet: { label: 'Greet', onSelect: (controls) => controls.appendText('Hallo') } }, plusMenu: { items: ['greet', 'trigger:@'] } }}>
        <ChatInput />
      </Setup>,
    );
    openMenu();
    expect(menuItems().map((item) => item.textContent)).toEqual(['Greet']);
    fireEvent.click(menuItems()[0]!);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Hallo');
  });

  it('stays open and usable while a turn streams with the queue on', async () => {
    function Streaming({ status }: { status: ChatTransport['status'] }) {
      const chat = useMemo(() => transport(), []);
      const current = useMemo(() => ({ ...chat, status }), [chat, status]);
      const chatInteractions = useMemo(() => ({ entities: [person] }), []);
      return (
        <AiChatProvider transport={current} attachments chatInteractions={chatInteractions} triggers={TRIGGERS} composer={plusAtStart} queue={{ enabled: true }}>
          <MentionInput />
        </AiChatProvider>
      );
    }
    const { rerender } = render(<Streaming status="ready" />);
    openMenu();
    rerender(<Streaming status="streaming" />);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect((plusButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('textbox').textContent).toBe('@');
    await waitFor(() => expect(screen.getByRole('option', { name: /Müller/ })).toBeTruthy());
  });

  it('is disabled while loading without the queue', () => {
    function Streaming() {
      const chat = useMemo(() => ({ ...transport(), status: 'streaming' as const }), []);
      return (
        <AiChatProvider transport={chat} attachments composer={plusAtStart}>
          <MentionInput />
        </AiChatProvider>
      );
    }
    render(<Streaming />);
    expect((plusButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(plusButton());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

