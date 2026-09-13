// @vitest-environment jsdom
import React, { useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatTransport, SessionConfig } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';
import { SessionSwitcher } from '../../components/session-switcher.js';
import { ChatInput } from '../../components/chat-input.js';

const history = (id: string): ChatMessage[] => [{
  id, role: 'user', parts: [{ type: 'text', text: `History ${id}` }],
}];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function Probe() {
  const { messages, activeSessionId, switchSession, createSession, removeSession, send } = useChatContext();
  return <>
    <SessionSwitcher />
    <div data-testid="session">{activeSessionId}</div>
    <div data-testid="history">{messages.map((message) => message.id).join(',')}</div>
    <button onClick={() => void switchSession('b')}>B</button>
    <button onClick={() => void switchSession('c')}>C</button>
    <button onClick={() => void createSession()}>New</button>
    <button onClick={() => void removeSession(activeSessionId)}>Delete</button>
    <button onClick={() => void send('hello')}>Send</button>
  </>;
}
function Harness({ session, status = 'ready', onSend = async () => {}, composer = false }: {
  session: SessionConfig; status?: ChatTransport['status']; onSend?: ChatTransport['sendMessage']; composer?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const transport = useMemo<ChatTransport>(() => ({
    messages, setMessages, status, error: null,
    sendMessage: onSend, stop: () => {},
    addToolApprovalResponse: async () => {},
  }), [messages, status, onSend]);
  return <AiChatProvider transport={transport} session={session}><Probe />{composer && <ChatInput />}</AiChatProvider>;
}

describe('session persistence ownership', () => {
  afterEach(cleanup);

  it('never writes the old history into the destination while its load is pending', async () => {
    const pending = deferred<ChatMessage[]>();
    const save = vi.fn();
    render(<Harness session={{
      defaultActiveId: 'a', save,
      load: (id) => id === 'a' ? history('a') : pending.promise,
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    fireEvent.click(screen.getByText('B'));
    await waitFor(() => expect(screen.getByTestId('session').textContent).toBe('b'));
    expect(save.mock.calls.filter(([id]) => id === 'b')).toEqual([]);
    expect(screen.getByTestId('history').textContent).not.toContain('a');
    await act(async () => pending.resolve(history('b')));
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('b'));
    expect(save.mock.calls.filter(([id]) => id === 'b')).toEqual([['b', history('b')]]);
  });

  it('ignores a late restore from a session which has already been left', async () => {
    const pending = deferred<ChatMessage[]>();
    const save = vi.fn();
    render(<Harness session={{
      defaultActiveId: 'a', save,
      load: (id) => id === 'b' ? pending.promise : history(id),
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByText('C'));
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('c'));
    await act(async () => pending.resolve(history('b')));
    expect(screen.getByTestId('history').textContent).toBe('c');
    expect(save.mock.calls.filter(([id]) => id === 'c').every(([, rows]) => rows[0].id === 'c')).toBe(true);
    expect(save.mock.calls.filter(([id]) => id === 'b')).toEqual([]);
  });

  it('loads an explicitly configured default session instead of treating it as a sentinel', async () => {
    const load = vi.fn(() => history('default'));
    render(<Harness session={{
      defaultActiveId: 'default', load,
      list: async () => [{ id: 'default', title: 'Existing chat' }],
      create: async () => ({ id: 'new', title: 'New' }), remove: async () => {},
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('default'));
    expect(load).toHaveBeenCalledWith('default');
  });

  it('does not send with a history which is still being restored', async () => {
    const pending = deferred<ChatMessage[]>();
    const onSend = vi.fn(async () => {});
    render(<Harness onSend={onSend} session={{ defaultActiveId: 'a', load: () => pending.promise }} />);
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => pending.resolve(history('a')));
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('does not switch, create or remove sessions during an active stream', async () => {
    const create = vi.fn(async () => ({ id: 'new', title: 'New' }));
    const remove = vi.fn(async () => {});
    render(<Harness status="streaming" session={{
      defaultActiveId: 'a', load: (id) => history(id), create, remove,
      list: async () => [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByText('New'));
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByTestId('session').textContent).toBe('a');
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('allows creating the first chat when an initially empty list has no history to load', async () => {
    render(<Harness composer session={{
      load: () => [], list: async () => [],
      create: async () => ({ id: 'first', title: 'First' }), remove: async () => {},
    }} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'New chat' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('allows retrying a failed restore from the switcher without overwriting saved history', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const load = vi.fn().mockRejectedValueOnce(new Error('private detail')).mockResolvedValue(history('a'));
      const save = vi.fn();
      render(<Harness session={{
        defaultActiveId: 'a', load, save,
        list: async () => [{ id: 'a', title: 'Saved chat' }],
        create: async () => ({ id: 'new', title: 'New' }), remove: async () => {},
      }} />);
      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      const trigger = await screen.findByRole('button', { name: 'Saved chat' });
      expect((trigger as HTMLButtonElement).disabled).toBe(false);
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('option', { name: /Saved chat/ }));
      await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    } finally { warn.mockRestore(); }
  });

  it('restores a real default id discovered by the initial session list', async () => {
    const load = vi.fn(() => history('default'));
    render(<Harness session={{ load,
      list: async () => [{ id: 'another', title: 'Other' }, { id: 'default', title: 'Existing' }],
      create: async () => ({ id: 'new', title: 'New' }), remove: async () => {},
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('default'));
    expect(screen.getByTestId('session').textContent).toBe('default');
  });

  it('does not resume an old create callback into a now-streaming transport', async () => {
    const pending = deferred<{ id: string; title: string }>();
    const session: SessionConfig = {
      defaultActiveId: 'a', load: (id) => history(id), create: () => pending.promise,
      list: async () => [{ id: 'a', title: 'A' }], remove: async () => {},
    };
    const { rerender } = render(<Harness session={session} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    fireEvent.click(screen.getByText('New'));
    rerender(<Harness session={session} status="streaming" />);
    await act(async () => pending.resolve({ id: 'new', title: 'New' }));
    expect(screen.getByTestId('session').textContent).toBe('a');
  });

  it('does not start a send while the current session is being deleted', async () => {
    const pending = deferred<void>();
    const onSend = vi.fn(async () => {});
    render(<Harness onSend={onSend} session={{
      defaultActiveId: 'a', load: (id) => history(id), remove: () => pending.promise,
      list: async () => [{ id: 'b', title: 'B' }], create: async () => ({ id: 'new', title: 'New' }),
    }} />);
    await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('a'));
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
  });
});
