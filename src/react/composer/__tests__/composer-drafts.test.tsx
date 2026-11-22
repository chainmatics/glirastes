// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { MentionInput } from '../../components/mention-input.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatMessage, ChatTransport, SessionConfig } from '../../types.js';

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const people: ChatCompletionProvider = {
  id: 'people', trigger: '@', search: () => [{ id: '7', type: 'person', label: 'Bug sieben' }],
};

function store() {
  const histories: Record<string, ChatMessage[]> = {};
  return (activeId: string): SessionConfig => ({
    activeId,
    load: async (id: string) => histories[id] ?? [],
    save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
  });
}

interface HostProps {
  chat: ChatTransport;
  session: SessionConfig;
  completion?: boolean;
  shown?: boolean;
  initialValue?: string;
}

function Host({ chat, session, completion = true, shown = true, initialValue }: HostProps) {
  const providers = useMemo(() => [people], []);
  return (
    <AiChatProvider transport={chat} session={session} {...(completion ? { completionProviders: providers } : {})}>
      {shown && (initialValue === undefined ? <AiChatPanel /> : <MentionInput initialValue={initialValue} />)}
    </AiChatProvider>
  );
}

const editor = () => screen.getByRole('textbox');
const text = () => {
  const element = editor();
  return element instanceof HTMLTextAreaElement ? element.value : element.textContent;
};

function typeInto(element: HTMLElement, value: string) {
  if (element instanceof HTMLTextAreaElement) {
    fireEvent.change(element, { target: { value } });
    return;
  }
  element.textContent = value;
  const range = document.createRange();
  range.setStart(element.firstChild!, value.length);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.input(element);
}

async function ready() {
  await waitFor(() => expect(editor().getAttribute('aria-disabled') === 'true' || (editor() as HTMLTextAreaElement).disabled === true).toBe(false));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
});

describe('composer draft per chat', () => {
  it('text typed in chat A is back after switching to B and back; B starts empty', async () => {
    const chat = transport();
    const sessions = store();
    const view = render(<Host chat={chat} session={sessions('A')} />);
    await ready();
    typeInto(editor(), 'Entwurf in A');
    view.rerender(<Host chat={chat} session={sessions('B')} />);
    await ready();
    expect(text()).toBe('');
    typeInto(editor(), 'Entwurf in B');
    view.rerender(<Host chat={chat} session={sessions('A')} />);
    await ready();
    expect(text()).toBe('Entwurf in A');
    view.rerender(<Host chat={chat} session={sessions('B')} />);
    await ready();
    expect(text()).toBe('Entwurf in B');
  });

  it('the draft survives a remount of the input', async () => {
    const chat = transport();
    const session = store()('A');
    const view = render(<Host chat={chat} session={session} />);
    await ready();
    typeInto(editor(), 'bleibt');
    view.rerender(<Host chat={chat} session={session} shown={false} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    view.rerender(<Host chat={chat} session={session} />);
    await ready();
    expect(text()).toBe('bleibt');
  });

  it('a sent message clears the draft', async () => {
    const chat = transport();
    const session = store()('A');
    const view = render(<Host chat={chat} session={session} />);
    await ready();
    typeInto(editor(), 'abschicken');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    view.rerender(<Host chat={chat} session={session} shown={false} />);
    view.rerender(<Host chat={chat} session={session} />);
    await ready();
    expect(text()).toBe('');
  });

  it('mentions survive a switch', async () => {
    const chat = transport();
    const sessions = store();
    const view = render(<Host chat={chat} session={sessions('A')} />);
    await ready();
    typeInto(editor(), 'Siehe @bu');
    await waitFor(() => expect(screen.getByRole('option', { name: /Bug sieben/ })).toBeTruthy());
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(editor().querySelector('[data-mention-id="7"]')).not.toBeNull());
    view.rerender(<Host chat={chat} session={sessions('B')} />);
    await ready();
    expect(editor().querySelector('[data-mention-id="7"]')).toBeNull();
    view.rerender(<Host chat={chat} session={sessions('A')} />);
    await ready();
    const pill = editor().querySelector('[data-mention-id="7"]');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-mention-type')).toBe('person');
  });

  it('drafts die with the provider', async () => {
    const chat = transport();
    const session = store()('A');
    const view = render(<Host chat={chat} session={session} />);
    await ready();
    typeInto(editor(), 'von Nutzer A');
    view.unmount();
    render(<Host chat={chat} session={session} />);
    await ready();
    expect(text()).toBe('');
  });

  it('initialValue applies only without a draft', async () => {
    const chat = transport();
    const session = store()('A');
    const view = render(<Host chat={chat} session={session} initialValue="Vorgabe" />);
    await ready();
    expect(text()).toBe('Vorgabe');
    typeInto(editor(), 'eigener Text');
    view.rerender(<Host chat={chat} session={session} shown={false} initialValue="Vorgabe" />);
    view.rerender(<Host chat={chat} session={session} initialValue="Vorgabe" />);
    await ready();
    expect(text()).toBe('eigener Text');
  });

  it('the plain input keeps its draft per session too', async () => {
    const chat = transport();
    const sessions = store();
    const view = render(<Host chat={chat} session={sessions('A')} completion={false} />);
    await ready();
    expect(editor().tagName).toBe('TEXTAREA');
    typeInto(editor(), 'plain A');
    view.rerender(<Host chat={chat} session={sessions('B')} completion={false} />);
    await ready();
    expect(text()).toBe('');
    view.rerender(<Host chat={chat} session={sessions('A')} completion={false} />);
    await ready();
    expect(text()).toBe('plain A');
  });
});
