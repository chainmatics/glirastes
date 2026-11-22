// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatComponents, ChatTransport, ComposerConfig, ComposerToolbarProps } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { MentionInput } from '../mention-input.js';

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: () => [{ id: '7', label: 'Müller' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Müller' } : undefined),
});
const TRIGGERS = [{ char: '@', label: 'Mention' }];

let sent: ReturnType<typeof vi.fn>;
function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: sent, stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Setup({ composer, components, interactions = true, children }: {
  composer?: ComposerConfig; components?: ChatComponents; interactions?: boolean; children: ReactNode;
}) {
  const chatInteractions = useMemo(() => ({ entities: [person] }), []);
  const t = useMemo(transport, []);
  return (
    <AiChatProvider transport={t} {...(interactions ? { chatInteractions, triggers: TRIGGERS } : {})}
      {...(composer ? { composer } : {})} {...(components ? { components } : {})}>
      {children}
    </AiChatProvider>
  );
}

const stacked: ComposerConfig = { layout: 'stacked', toolbar: { start: ['plus', 'trigger:@'], end: ['send'] } };
const kind = (el: Element) => el.getAttribute('data-component') ?? el.getAttribute('data-action') ?? el.tagName.toLowerCase();

beforeEach(() => {
  sent = vi.fn(async () => {});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('composer layout', () => {
  it('inline stays the 0.22 markup', () => {
    const inline = render(<Setup composer={{ layout: 'inline' }}><MentionInput /></Setup>);
    const html = inline.container.querySelector('form')!.outerHTML;
    expect(inline.container.querySelector('[data-component="composer-toolbar"]')).toBeNull();
    inline.unmount();
    const plain = render(<Setup><MentionInput /></Setup>);
    expect(plain.container.querySelector('form')!.outerHTML).toBe(html);
  });

  it('stacked puts the editor first and the items in one row under it', () => {
    const { container } = render(<Setup composer={stacked}><MentionInput /></Setup>);
    const form = container.querySelector('form')!;
    const children = Array.from(form.children).map(kind);
    const editorIndex = children.indexOf('rich-mention-input');
    expect(children.slice(editorIndex)).toEqual(['rich-mention-input', 'composer-toolbar']);
    // Only hidden inputs may come before the editor.
    for (const el of Array.from(form.children).slice(0, editorIndex)) expect(el.tagName).toBe('INPUT');
    const toolbar = form.querySelector<HTMLElement>(':scope > [data-component="composer-toolbar"]')!;
    expect(toolbar.dataset.layout).toBe('stacked');
    const start = toolbar.querySelector('[data-element="toolbar-start"]')!;
    const end = toolbar.querySelector('[data-element="toolbar-end"]')!;
    expect(Array.from(toolbar.children)).toEqual([start, end]);
    expect(start.querySelector('[data-component="composer-plus-button"]')).not.toBeNull();
    expect(start.querySelector('[data-component="composer-trigger-button"]')).not.toBeNull();
    expect(end.querySelector('[data-action="send"]')).not.toBeNull();
  });

  it('stacked works with the plain input', () => {
    const { container } = render(
      <Setup interactions={false} composer={{ layout: 'stacked', toolbar: { start: ['mic'], end: ['send'] } }}><ChatInput /></Setup>,
    );
    const form = container.querySelector('form')!;
    expect(Array.from(form.children).map(kind)).toEqual(['textarea', 'composer-toolbar']);
    expect(form.querySelector('[data-element="toolbar-end"] [data-action="send"]')).not.toBeNull();
  });

  it('components.ComposerToolbar wins over layout', () => {
    function Own({ start, end, editor }: ComposerToolbarProps) {
      return <>{editor}<div data-testid="own">{start}{end}</div></>;
    }
    const { container } = render(<Setup composer={stacked} components={{ ComposerToolbar: Own }}><MentionInput /></Setup>);
    expect(container.querySelector('[data-component="composer-toolbar"]')).toBeNull();
    expect(screen.getByTestId('own')).toBeTruthy();
  });

  it('the plus menu and send still work stacked', async () => {
    render(<Setup composer={stacked}><MentionInput /></Setup>);
    const plus = screen.getByRole('button', { name: 'More actions' });
    fireEvent.keyDown(plus, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention' }));
    const editor = screen.getByRole('textbox');
    expect(editor.textContent).toBe('@');
    await waitFor(() => expect(screen.getByRole('option', { name: /Müller/ })).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id], [data-type]')).not.toBeNull());
    const send = document.querySelector<HTMLButtonElement>('[data-element="toolbar-end"] [data-action="send"]')!;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(sent).toHaveBeenCalled());
  });
});
