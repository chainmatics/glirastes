// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage, ChatTransport } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import {
  defineToolResultRenderer,
  type AnyToolResultRenderer,
} from '../../tool-renderers/registry.js';
import { MessageList } from '../message-list.js';

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function toolMessage(id: string, output: unknown): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'tool-tasks_listTasks', toolCallId: `call-${id}`, state: 'output-available', output }],
  } as unknown as ChatMessage;
}

const taskList = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 2,
  outputSchema: z.object({
    success: z.literal(true),
    data: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  component: ({ output }) => (
    <ul aria-label="Aufgaben">
      {output.data.map((task) => <li key={task.id}>{task.title}</li>)}
    </ul>
  ),
});

function renderWith(messages: ChatMessage[], renderers: AnyToolResultRenderer[]) {
  return render(
    <AiChatProvider transport={transport(messages)} toolRenderers={renderers}>
      <MessageList />
    </AiChatProvider>,
  );
}

describe('custom tool result renderers', () => {
  afterEach(cleanup);

  it('renders a registered compact component with its definition and version', () => {
    renderWith(
      [toolMessage('m1', { success: true, data: [{ id: '1', title: 'Bericht schreiben' }] })],
      [taskList],
    );
    expect(screen.getByRole('list', { name: 'Aufgaben' }).textContent).toBe('Bericht schreiben');
    const block = document.querySelector('[data-renderer="tasks.listTasks"]');
    expect(block?.getAttribute('data-schema-version')).toBe('2');
  });

  it('uses the default block for an old message that no version accepts', () => {
    renderWith([toolMessage('m1', { success: true, data: ['nur Titel'] })], [taskList]);
    expect(screen.queryByRole('list', { name: 'Aufgaben' })).toBeNull();
    expect(document.querySelector('[data-component="tool-result"] summary')?.textContent)
      .toBe('tasks_listTasks');
  });

  it('degrades to the default block when the custom renderer throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWith(
        [toolMessage('m1', { success: true, data: [{ id: '1', title: 'x' }] })],
        [{ ...taskList, component: () => { throw new Error('render bug'); } }],
      );
      expect(document.querySelector('[data-component="tool-result"] summary')?.textContent)
        .toBe('tasks_listTasks');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('renders again when a different renderer version resolves after a failure', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const chat = transport([
        toolMessage('m1', { success: true, data: [{ id: '1', title: 'Bericht schreiben' }] }),
      ]);
      const failingV2: AnyToolResultRenderer = {
        ...taskList,
        component: () => { throw new Error('render bug'); },
      };
      const view = render(
        <AiChatProvider transport={chat} toolRenderers={[failingV2]}>
          <MessageList />
        </AiChatProvider>,
      );
      expect(screen.queryByRole('list', { name: 'Aufgaben' })).toBeNull();

      view.rerender(
        <AiChatProvider transport={chat} toolRenderers={[{ ...taskList, schemaVersion: 1 }]}>
          <MessageList />
        </AiChatProvider>,
      );
      expect(screen.getByRole('list', { name: 'Aufgaben' }).textContent).toBe('Bericht schreiben');
      expect(document.querySelector('[data-renderer="tasks.listTasks"]')
        ?.getAttribute('data-schema-version')).toBe('1');
    } finally {
      consoleError.mockRestore();
    }
  });
});
