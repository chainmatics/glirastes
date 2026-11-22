// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { MentionInput } from '../../components/mention-input.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatMessage, ChatTransport, ComposerDraft, ComposerDraftStorage, SessionConfig } from '../../types.js';
import { clearLocalSessionStore, createLocalSessionStore } from '../../utils/local-session-store.js';
import { useChatContext } from '../../provider/chat-context.js';

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
      <Actions />
    </AiChatProvider>
  );
}

let actions: { removeSession: (id: string) => Promise<void>; clear: () => void } | null = null;
function Actions() {
  actions = useChatContext();
  return null;
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

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

function spyDraft(load: ComposerDraftStorage['load'] = () => null) {
  return { load: vi.fn(load), save: vi.fn((_id: string, _draft: ComposerDraft | null) => {}) };
}

function withDraft(activeId: string, draft: ComposerDraftStorage): SessionConfig {
  return { activeId, load: async () => [], save: () => {}, draft };
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe('composer drafts in storage', () => {
  it('a draft is back after a reload', async () => {
    const chat = transport();
    const storage = memoryStorage();
    const session = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    const view = render(<Host chat={chat} session={session} />);
    await ready();
    typeInto(editor(), 'nach dem Neuladen');
    view.unmount();
    expect(JSON.parse(storage.data.get('app:u1:draft:default')!)).toMatchObject({ text: 'nach dem Neuladen' });
    const reloaded = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    render(<Host chat={chat} session={reloaded} />);
    await ready();
    await waitFor(() => expect(text()).toBe('nach dem Neuladen'));
  });

  it('writes are debounced and flushed on switch', async () => {
    const chat = transport();
    const draft = spyDraft();
    const view = render(<Host chat={chat} session={withDraft('A', draft)} />);
    await ready();
    for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde']) typeInto(editor(), value);
    expect(draft.save).not.toHaveBeenCalled();
    await pause(400);
    expect(draft.save).toHaveBeenCalledTimes(1);
    expect(draft.save).toHaveBeenLastCalledWith('A', { text: 'abcde' });
    typeInto(editor(), 'abcdef');
    view.rerender(<Host chat={chat} session={withDraft('B', draft)} />);
    await ready();
    await pause(400);
    expect(draft.save).toHaveBeenCalledWith('A', { text: 'abcdef' });
  });

  it('pagehide flushes', async () => {
    const chat = transport();
    const draft = spyDraft();
    render(<Host chat={chat} session={withDraft('A', draft)} />);
    await ready();
    typeInto(editor(), 'gleich weg');
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(draft.save).toHaveBeenCalledWith('A', { text: 'gleich weg' });
  });

  it('a 20001-character draft is not written', async () => {
    const chat = transport();
    const draft = spyDraft();
    render(<Host chat={chat} session={withDraft('A', draft)} completion={false} />);
    await ready();
    typeInto(editor(), 'x'.repeat(20_001));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(draft.save.mock.calls.some(([, value]) => value !== null)).toBe(false);
    // An older, shorter version must not come back after a reload.
    expect(draft.save).toHaveBeenCalledWith('A', null);
    expect(text()).toHaveLength(20_001);
  });

  it('a late load does not overwrite typing', async () => {
    const chat = transport();
    let resolve!: (draft: ComposerDraft | null) => void;
    const draft = spyDraft(() => new Promise<ComposerDraft | null>((done) => { resolve = done; }));
    render(<Host chat={chat} session={withDraft('A', draft)} />);
    await ready();
    expect(draft.load).toHaveBeenCalledWith('A');
    typeInto(editor(), 'schon getippt');
    await act(async () => { resolve({ text: 'alter Entwurf' }); });
    expect(text()).toBe('schon getippt');
  });
});

describe('forgotten drafts stay gone', () => {
  const drafted = (storage: ReturnType<typeof memoryStorage>) => [...storage.data.keys()].filter((key) => key.includes(':draft:'));

  async function typed(storage: ReturnType<typeof memoryStorage>) {
    const chat = transport();
    let next = 0;
    const session = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null, createId: () => `s${++next}` });
    const view = render(<Host chat={chat} session={session} />);
    await ready();
    return { view, session };
  }

  it('a keystroke and then deleting the chat within 300 ms stores nothing', async () => {
    const storage = memoryStorage();
    const { session } = await typed(storage);
    const created = await session.create!();
    typeInto(editor(), 'gleich gelöscht');
    await act(async () => { await actions!.removeSession('default'); });
    await pause(400);
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(drafted(storage)).toEqual([]);
    expect(created.id).toBe('s1');
  });

  it('a keystroke and then clearing the chat within 300 ms stores nothing', async () => {
    const storage = memoryStorage();
    await typed(storage);
    typeInto(editor(), 'gleich geleert');
    act(() => { actions!.clear(); });
    await pause(400);
    expect(drafted(storage)).toEqual([]);
  });

  it('a keystroke, then clearLocalSessionStore, then unmount stores nothing', async () => {
    const storage = memoryStorage();
    const { view } = await typed(storage);
    typeInto(editor(), 'abgemeldet');
    await clearLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    view.unmount();
    await pause(400);
    expect(drafted(storage)).toEqual([]);
    // A store created after the sign-out keeps drafts again.
    const fresh = createLocalSessionStore({ storageKey: 'app:u1', storage, attachmentStore: null });
    await fresh.draft!.save('default', { text: 'neu' });
    expect(drafted(storage)).toEqual(['app:u1:draft:default']);
  });
});
