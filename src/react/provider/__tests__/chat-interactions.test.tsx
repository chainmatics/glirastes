// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChatCommandMessage, parseChatCommandMessage } from '../../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { MessageBubble } from '../../components/message-bubble.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { useChatInteractionsData } from '../../interactions/use-chat-interactions-data.js';
import type { ChatMessage, ChatTransport, MentionData } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../chat-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: 'Task',
    actions: [{ id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } }],
  }],
  commands: [
    { id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: 'Filter Tasks',
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: () => [{ id: 'alice', label: 'Alice' }],
  resolve: (id) => (id === 'alice' ? { id: 'alice', label: 'Alice Example' } : undefined),
});

const standup = defineChatCommand({ id: 'standup', label: 'Stand-up', run: { kind: 'prompt', prompt: 'Summarize my day.' } });

function transport(messages: ChatMessage[] = []): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages,
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function mount(chat: ChatTransport) {
  let context: ChatContextValue | undefined;
  function Probe() {
    context = useChatContext();
    return null;
  }
  function Harness({ children }: { children?: ReactNode }) {
    const interactions = useMemo(() => ({ data, entities: [person], commands: [standup] }), []);
    return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe />{children}</AiChatProvider>;
  }
  render(<Harness />);
  return () => context!;
}

const command = (id: string, slug: string): MentionData => ({ id, type: 'command', label: slug, prefix: '/', slug });

describe('chat interactions in AiChatProvider', () => {
  it('sends a command picked alone as a direct command, skipping mention markup', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().send('/open-overview', { mentions: [command('open.overview', 'open-overview')] }); });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    const sent = chat.sendMessage.mock.calls[0]![0].text as string;
    expect(parseChatCommandMessage(sent)?.invocation).toEqual({
      commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' },
    });
    expect(sent).not.toContain('<!--context');
  });

  it('opens the pending command for missing arguments and sends the completed command', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().send('/filter-tasks', { mentions: [command('filter.tasks', 'filter-tasks')] }); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(context().pendingCommand).toMatchObject({ commandId: 'filter.tasks', label: 'Filter Tasks' });
    await act(async () => { context().submitPendingCommand({ status: 'done' }); });
    expect(context().pendingCommand).toBeNull();
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation.args).toEqual({ status: 'done' });

    await act(async () => { context().send('/filter-tasks', { mentions: [command('filter.tasks', 'filter-tasks')] }); });
    await act(async () => { context().cancelPendingCommand(); });
    expect(context().pendingCommand).toBeNull();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('runs an entity action with the entity id and lets a prompt command reach the model', async () => {
    const chat = transport();
    const context = mount(chat);
    await act(async () => { context().runEntityAction({ type: 'task', id: '7', label: 'Release prüfen' }, 'task.tasks.complete'); });
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Complete @Release prüfen',
    });
    await act(async () => { context().send('/stand-up', { mentions: [command('standup', 'stand-up')] }); });
    expect(chat.sendMessage.mock.calls[1]![0]).toEqual({ text: 'Summarize my day.' });
  });

  it('queues a resolved entity reference for the composer and refuses unknown ids', async () => {
    const context = mount(transport());
    let added = false;
    await act(async () => { added = await context().mentionEntity('person', 'alice'); });
    expect(added).toBe(true);
    expect(context().composerMentions).toEqual([{
      id: 'alice', type: 'person', label: 'Alice Example', displayName: 'Alice Example', prefix: '@', slug: 'alice-example',
    }]);
    await act(async () => { context().consumeComposerMentions(); });
    expect(context().composerMentions).toEqual([]);
    await act(async () => { added = await context().mentionEntity('person', 'mallory'); });
    expect(added).toBe(false);
    await act(async () => { added = await context().mentionEntity('task', '7'); });
    expect(added).toBe(false);
  });

  it('shows a sent command by its label only', () => {
    const text = formatChatCommandMessage({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview' });
    const message: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
    const view = render(<AiChatProvider transport={transport([message])}><MessageBubble message={message} /></AiChatProvider>);
    expect(view.container.textContent).toContain('/Open Overview');
    expect(view.container.innerHTML).not.toContain('glirastes:command');
  });
});

describe('useChatInteractionsData', () => {
  it('loads and validates the interactions once per endpoint', async () => {
    const fetch = vi.fn(async () => Response.json(data));
    const { result } = renderHook(() => useChatInteractionsData('/chat', { fetch }));
    await waitFor(() => expect(result.current).toEqual(data));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/chat', expect.objectContaining({ method: 'GET', credentials: 'same-origin' })]);
  });

  it('reports refused or invalid responses and keeps the chat without interactions', async () => {
    const onError = vi.fn();
    const invalid = vi.fn(async () => Response.json({ schemaVersion: 1, entities: [], commands: [{ id: 'x' }] }));
    const { result } = renderHook(() => useChatInteractionsData('/chat', { fetch: invalid, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    renderHook(() => useChatInteractionsData('/chat', { fetch: refused, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});
