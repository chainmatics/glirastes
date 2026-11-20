// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type {
  ChatCompletionProvider,
  ChatTransport,
  ChatTriggerDefinition,
  ComposerConfig,
} from '../../types.js';
import { MentionInput } from '../mention-input.js';

// Mirrors the end-to-end example in skills/building-glirastes-chat-ui/references/composer-triggers-toolbar.md.
const triggers: ReadonlyArray<ChatTriggerDefinition> = [
  { char: '@', label: 'Person erwähnen' },
  { char: '/', label: 'Vorlagen' },
];

const templates: ChatCompletionProvider = {
  id: 'templates',
  trigger: '/',
  search: () => [
    { id: 'summary', type: 'template', label: 'Auftrag zusammenfassen', select: 'text', insertText: 'Fasse den Auftrag zusammen' },
  ],
};

const composer: ComposerConfig = {
  toolbar: { start: ['plus', 'trigger:@', 'trigger:/'], end: ['mic', 'send'] },
  plusMenu: { items: ['attach'], source: { trigger: '/', source: 'templates', label: 'Vorlagen' } },
};

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Chat({ provider = templates }: { provider?: ChatCompletionProvider }) {
  const providers = useMemo(() => [provider], [provider]);
  return (
    <AiChatProvider transport={transport()} completionProviders={providers} triggers={triggers} composer={composer} language="de">
      <MentionInput />
    </AiChatProvider>
  );
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('composer toolbar example', () => {
  it('renders plus, @ and / before the editor and send after it', () => {
    const { container } = render(<Chat />);
    const plus = screen.getByRole('button', { name: 'Mehr Aktionen' });
    const mention = screen.getByRole('button', { name: 'Person erwähnen' });
    const command = screen.getByRole('button', { name: 'Vorlagen' });
    const editor = container.querySelector('[contenteditable]') as HTMLElement;
    const buttons = Array.from(container.querySelectorAll('button'));
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(plus, mention)).toBe(true);
    expect(before(mention, command)).toBe(true);
    expect(before(command, editor)).toBe(true);
    // The last button sits behind the editor: send. mic is absent without voice.enabled.
    expect(before(editor, buttons[buttons.length - 1]!)).toBe(true);
  });

  it('lists the prompt template in the plus menu and inserts its text', async () => {
    render(<Chat />);
    fireEvent.click(screen.getByRole('button', { name: 'Mehr Aktionen' }));
    const row = await screen.findByRole('menuitem', { name: 'Auftrag zusammenfassen' });
    fireEvent.click(row);
    await waitFor(() => expect(document.body.textContent).toContain('Fasse den Auftrag zusammen'));
  });

  it('opens no empty menu when the source finds nothing and there is no attach row, and Escape closes it', async () => {
    const empty: ChatCompletionProvider = { id: 'templates', trigger: '/', search: async () => [] };
    render(<Chat provider={empty} />);
    const plus = screen.getByRole('button', { name: 'Mehr Aktionen' });
    fireEvent.click(plus);
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(plus, { key: 'Escape' });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
  });
});
