// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const budget = defineChatCommand({
  id: 'tasks.budget',
  label: 'Budget $&',
  args: [{ name: 'amount', label: 'Cost $&', required: true }],
  run: { kind: 'tool', tool: 'tasks.budget' },
});

const find = defineChatCommand({
  id: 'tasks.find',
  label: 'Find',
  args: [{ name: 'assignee', label: 'Person', entity: 'person' }],
  run: { kind: 'tool', tool: 'tasks.find' },
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
  const interactions = useMemo(() => ({ entities: [person], commands: [assign, find, budget] }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions}><Probe /><MentionInput /></AiChatProvider>;
}

const picked: MentionData = { id: 'tasks.assign', type: 'command', label: 'Assign', prefix: '/', slug: 'assign' };
const pickedBudget: MentionData = { id: 'tasks.budget', type: 'command', label: 'Budget $&', prefix: '/', slug: 'budget' };
const pickedFind: MentionData = { id: 'tasks.find', type: 'command', label: 'Find', prefix: '/', slug: 'find' };

async function openForm(command: MentionData = picked) {
  const chat = transport();
  render(<Composer chat={chat} />);
  await act(async () => { context!.send(`/${command.slug}`, { mentions: [command] }); });
  const form = await screen.findByRole('form', { name: `Details for ${command.label}` });
  return { chat, form };
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
}

/** The labels of the person options a user can currently see. */
function listed(): string[] {
  const listbox = screen.queryByRole('listbox', { name: 'Person' });
  return listbox ? within(listbox).getAllByRole('option').map((option) => option.textContent ?? '') : [];
}

/** Moves focus to Run like a user does, then submits through the button. */
async function pressRun() {
  const run = screen.getByRole('button', { name: 'Run' });
  await act(async () => { run.focus(); });
  fireEvent.click(run);
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

  it('does not pick from the results of an earlier query while the new search is pending', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' }) as HTMLInputElement;
    fireEvent.change(personField, { target: { value: 'e' } });
    await settle();
    expect(listed()).toEqual(['Alice Example', 'Bob Builder']);

    fireEvent.change(personField, { target: { value: 'bo' } });
    expect(listed()).toEqual([]);
    expect(personField.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('No matches')).toBeNull();
    expect(fireEvent.keyDown(personField, { key: 'Enter' })).toBe(false);
    expect(personField.value).toBe('bo');

    await settle();
    expect(listed()).toEqual(['Bob Builder']);
    fireEvent.keyDown(personField, { key: 'Enter' });
    expect(personField.value).toBe('Bob Builder');
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'bis Freitag' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation.args)
      .toEqual({ assignee: 'bob', note: 'bis Freitag' });
  });

  it('says which required value is missing, keeps the typed text and keeps focus in the form', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' }) as HTMLInputElement;
    const note = screen.getByRole('textbox', { name: 'Note *' });
    fireEvent.change(personField, { target: { value: 'ali' } });
    await settle();
    fireEvent.change(note, { target: { value: 'bis Freitag' } });

    await pressRun();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe('Please complete: Person');
    expect(personField.getAttribute('aria-invalid')).toBe('true');
    expect(personField.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(note.getAttribute('aria-invalid')).toBeNull();
    expect(document.activeElement).toBe(personField);
    expect(personField.value).toBe('ali');

    await settle();
    fireEvent.keyDown(personField, { key: 'Enter' });
    expect(personField.value).toBe('Alice Example');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(personField.getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('lists every missing required value, focuses the first and clears a value once it is given', async () => {
    const { chat } = await openForm();
    await pressRun();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe('Please complete: Person, Note');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Person *' }));
    const note = screen.getByRole('textbox', { name: 'Note *' });
    expect(note.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(note, { target: { value: 'bis Freitag' } });
    expect(note.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Please complete: Person');
  });

  it('does not drop text typed into an optional person field without a pick', async () => {
    const { chat } = await openForm(pickedFind);
    const field = screen.getByRole('combobox', { name: 'Person' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'bo' } });

    await pressRun();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe('Please complete: Person');
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('bo');

    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toMatchObject({ commandId: 'tasks.find', args: {} });
  });

  it('cancels with the first Escape while no list is showing', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    // Focused, results not loaded yet.
    expect(personField.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(personField, { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(context!.pendingCommand).toBeNull();

    await act(async () => { context!.send('/assign', { mentions: [picked] }); });
    const again = await screen.findByRole('combobox', { name: 'Person *' });
    fireEvent.change(again, { target: { value: 'xyz' } });
    await settle();
    expect(screen.getByText('No matches')).toBeTruthy();
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps focus in the form while the command still cannot run', async () => {
    const { chat } = await openForm();
    const personField = screen.getByRole('combobox', { name: 'Person *' });
    fireEvent.change(personField, { target: { value: 'ali' } });
    await settle();
    fireEvent.keyDown(personField, { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note *' }), { target: { value: 'x'.repeat(2_100) } });

    await pressRun();
    expect((await screen.findByRole('alert')).textContent).toBe('These values are too long.');
    // Same values and the same error: the form is not remounted, so nothing else may take focus.
    await pressRun();
    expect(screen.getByRole('alert').textContent).toBe('These values are too long.');
    expect(screen.getByRole('form').contains(document.activeElement)).toBe(true);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('tells the caller whether the pending command was run', async () => {
    await openForm();
    let refused: boolean | undefined;
    await act(async () => { refused = context!.submitPendingCommand({ assignee: 'alice' }); });
    expect(refused).toBe(false);
    expect(context!.pendingCommand).not.toBeNull();
    let ran: boolean | undefined;
    await act(async () => { ran = context!.submitPendingCommand({ assignee: 'alice', note: 'x' }); });
    expect(ran).toBe(true);
    expect(context!.pendingCommand).toBeNull();
    let idle: boolean | undefined;
    await act(async () => { idle = context!.submitPendingCommand({ assignee: 'alice', note: 'x' }); });
    expect(idle).toBe(false);
  });

  it('keeps labels with replacement patterns literal in the form name and the missing-values message', async () => {
    await openForm(pickedBudget);
    await pressRun();
    expect((await screen.findByRole('alert')).textContent).toBe('Please complete: Cost $&');
    expect(screen.getByRole('form').getAttribute('aria-label')).toBe('Details for Budget $&');
  });
});
