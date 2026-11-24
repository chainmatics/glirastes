// @vitest-environment jsdom

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import type { ChatTransport } from '../types.js';
import { formatChatCommandMessage } from '../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../contracts/chat-interactions.js';
import { createChatInteractionRegistry } from '../interactions/registry.js';
import { UNSTYLED_GUARD } from '../unstyled.js';
import { CHAT_STYLES } from '../../embed/chat-styles.generated.js';

afterEach(cleanup);

const P1 = '14f1e041-4609-4b24-a723-631b133115cc';
const P14 = '0df1344c-6fa7-4ea1-bc23-f0d12e01a0b1';
const UNSEEN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

function transport(calls: Array<{ input: Record<string, unknown> }>, tool = 'playlists_delete'): ChatTransport {
  return {
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Welche Playlists gibt es?' }] },
      {
        id: 'a0', role: 'assistant',
        parts: [{
          type: 'tool-playlists_list', toolCallId: 'list-1', state: 'output-available', input: {},
          output: {
            success: true,
            data: [{ id: P1, name: 'Abend-Promos' }, { id: P14, name: 'Morgen-Mix' }],
            _result: { id: 'ro_ab12cd34', arrays: { data: 2 }, showing: 2, total: 2, omitted: ['data[].tracks'], hint: 'Overview' },
          },
        } as never],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Lösch sie' }] },
      {
        id: 'a1', role: 'assistant',
        parts: calls.map((call, i) => ({
          type: `tool-${tool}`, toolCallId: `call-${i}`, state: 'approval-requested',
          input: call.input, approval: { id: `approval-${i}` },
        }) as never),
      },
    ],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

async function card(selector = '[data-component="approval-card"]') {
  await waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  return document.querySelector(selector) as HTMLElement;
}

describe('approval card names the ids of the call (default setup)', () => {
  it('shows the name an overview showed for the id and hides the id', async () => {
    const chat = transport([{ input: { id: P14 } }]);
    render(<AiChatProvider transport={chat}><AiChatPanel /></AiChatProvider>);
    const el = await card();
    expect(el.querySelector('[data-subject]')!.textContent).toBe('TargetMorgen-Mix');
    expect(el.textContent).not.toContain(P14);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm/ })); });
    // Display only: the approval answers the call as it was asked.
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: 'approval-0', approved: true });
  });

  it('warns about an id the conversation never showed and shows it', async () => {
    render(<AiChatProvider transport={transport([{ input: { playlistId: UNSEEN, note: 'weg' } }])}><AiChatPanel /></AiChatProvider>);
    const el = await card();
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('No name is known for this id in this conversation. Check it before you approve.');
    expect(warning.textContent).toContain(UNSEEN);
    expect(warning.querySelector('[data-element="detail-label"]')!.textContent).toBe('Playlist');
    // Non-id arguments stay as they were.
    expect(el.textContent).toContain('note');
    expect(el.textContent).toContain('Weg');
  });

  it('also names the ids when the app describes approvals itself', async () => {
    render(
      <AiChatProvider
        transport={transport([{ input: { id: P1 } }])}
        approvalDescription={(toolName, id, args) => ({ id, toolName, args: args as Record<string, unknown>, messageId: '', description: 'Playlist löschen' })}
      >
        <AiChatPanel />
      </AiChatProvider>,
    );
    const el = await card();
    expect(el.querySelector('[data-subject]')!.textContent).toBe('TargetAbend-Promos');
  });

  it('can be turned off', async () => {
    render(<AiChatProvider transport={transport([{ input: { id: UNSEEN } }])} approvalSubjects={false}><AiChatPanel /></AiChatProvider>);
    const el = await card();
    expect(el.querySelector('[data-subject]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names and warns on the grouped card of several calls', async () => {
    render(<AiChatProvider transport={transport([{ input: { id: P1 } }, { input: { id: UNSEEN } }])}><AiChatPanel /></AiChatProvider>);
    const el = await card('[data-component="bulk-approval-card"]');
    expect(el.querySelector('[data-element="detail-value"]')!.textContent).toBe('Abend-Promos');
    const warning = screen.getByRole('alert');
    expect(warning.querySelector('[data-element="subject-id"]')!.textContent).toBe(UNSEEN);
    expect(screen.getByRole('button', { name: /All 2/ }).getAttribute('aria-describedby')).toBe(warning.id);
  });
});

describe('approval card of a direct command', () => {
  const tasks: ChatInteractionsData = {
    schemaVersion: 1,
    entities: [{
      type: 'task', label: 'Task',
      actions: [{ id: 'task.tasks.delete', label: 'Delete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.delete' } }],
    }],
    commands: [],
  };

  /** The command message the chat sends for the picked task, and the confirmation the server asks for. */
  function commandTransport(text: string): ChatTransport {
    return {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text }] },
        {
          id: 'a1', role: 'assistant',
          parts: [{
            type: 'tool-tasks_delete', toolCallId: 'glirastes-command-0123456789abcdef0123', state: 'approval-requested',
            input: { taskId: UNSEEN }, approval: { id: 'approval-0' },
          } as never],
        },
      ],
      status: 'ready', error: null,
      sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
    };
  }

  it('names the object the user picked by its label, without the unknown-id warning', async () => {
    const plan = createChatInteractionRegistry({ data: tasks }).planAction({ type: 'task', id: UNSEEN, label: 'Release prüfen' }, 'task.tasks.delete');
    render(<AiChatProvider transport={commandTransport((plan as { text: string }).text)}><AiChatPanel /></AiChatProvider>);
    const el = await card();
    expect(el.querySelector('[data-subject]')!.textContent).toBe('TaskRelease prüfen');
    expect(el.textContent).not.toContain(UNSEEN);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still warns for an older command message that carries the name as plain text', async () => {
    const text = formatChatCommandMessage({ commandId: 'task.tasks.delete', tool: 'tasks.delete', args: { taskId: UNSEEN }, label: '/Delete @Release prüfen' });
    render(<AiChatProvider transport={commandTransport(text)}><AiChatPanel /></AiChatProvider>);
    await card();
    expect(screen.getByRole('alert').textContent).toContain('No name is known for this id in this conversation.');
  });
});

describe('id warning styles', () => {
  it('styles the warning with the danger colours, also in the embedded chat', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/react/styles.css'), 'utf8').replaceAll(UNSTYLED_GUARD, '');
    const at = css.indexOf('[data-component="ai-chat-panel"] [data-element="id-warning"] {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain('border-left: 3px solid var(--cm-danger)');
    expect(CHAT_STYLES).toContain('[data-element="id-warning"]');
  });
});
