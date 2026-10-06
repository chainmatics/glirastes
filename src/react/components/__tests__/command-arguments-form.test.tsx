// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import type { ChatTransport, MentionData } from '../../types.js';
import { MentionInput } from '../mention-input.js';

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: (query) => [{ id: 'alice', label: 'Alice Example' }, { id: 'bob', label: 'Bob Builder' }]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
});

const assign = defineChatCommand({
  id: 'tasks.assign',
  label: 'Assign',
  args: [
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
    { name: 'priority', label: 'Priority', options: ['high', 'low'] },
    { name: 'note', label: 'Note', required: true },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let context: ChatContextValue | undefined;
function Probe() {
  context = useChatContext();
  return null;
}

function Composer({ chat }: { chat: ChatTransport }) {
  const interactions = useMemo(() => ({ entities: [person], commands: [assign] }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe /><MentionInput /></AiChatProvider>;
}

const picked: MentionData = { id: 'tasks.assign', type: 'command', label: 'Assign', prefix: '/', slug: 'assign' };

async function openForm() {
  const chat = transport();
  render(<Composer chat={chat} />);
  await act(async () => { context!.send('/assign', { mentions: [picked] }); });
  const form = await screen.findByRole('form', { name: 'Details for Assign' });
  return { chat, form };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('CommandArgumentsForm', () => {
  it('asks for the missing arguments with focus on the first field and runs the command', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    expect(document.activeElement).toBe(personField);
    fireEvent.change(personField, { target: { value: 'ali' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const listbox = screen.getByRole('listbox', { name: 'Person' });
    expect(personField.getAttribute('aria-expanded')).toBe('true');
    expect(personField.getAttribute('aria-controls')).toBe(listbox.id);
    const option = screen.getByRole('option', { name: 'Alice Example' });
    expect(personField.getAttribute('aria-activedescendant')).toBe(option.id);
    fireEvent.keyDown(personField, { key: 'Enter' });
    expect((personField as HTMLInputElement).value).toBe('Alice Example');
    expect(personField.getAttribute('aria-expanded')).toBe('false');

    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: 'high' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'bis Freitag' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'tasks.assign', tool: 'tasks.assign', args: { assignee: 'alice', priority: 'high', note: 'bis Freitag' } },
      label: '/Assign @Alice Example high bis Freitag',
    });
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('textbox');
  });

  it('starts at the first required field the references left empty', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const alice: MentionData = { id: 'alice', type: 'person', label: 'Alice Example', prefix: '@', slug: 'alice-example' };
    await act(async () => { context!.send('/assign @alice-example', { mentions: [picked, alice] }); });
    await screen.findByRole('form', { name: 'Details for Assign' });
    expect((screen.getByRole('combobox', { name: 'Person *' }) as HTMLInputElement).value).toBe('Alice Example');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Note *' }));
  });

  it('keeps asking while a required value is missing', async () => {
    const { chat, form } = await openForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'x' } });
    fireEvent.submit(form);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole('form', { name: 'Details for Assign' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Note *' }) as HTMLInputElement).value).toBe('x');
  });

  it('closes an open list with Escape first and cancels the command with the next Escape', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    fireEvent.change(personField, { target: { value: 'b' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(personField.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(personField, { key: 'Escape' });
    expect(personField.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('form')).toBeTruthy();
    fireEvent.keyDown(personField, { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(context!.pendingCommand).toBeNull();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('says when values are too long instead of sending them', async () => {
    const { chat, form } = await openForm();
    await act(async () => { context!.submitPendingCommand({ assignee: 'alice', note: 'x'.repeat(2_100) }); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe('These values are too long.');
    expect(form).toBeTruthy();
  });
});
