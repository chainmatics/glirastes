// Browser fixture for tests/chat-interactions-browser.test.mjs: the same `@`
// entities and `/` commands in React and in <glirastes-chat>. No model, no
// network: the transport records what the composer sends.
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatInteractionsData } from '../../src/contracts/chat-interactions.js';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../../src/embed/index.js';
import { AiChatPanel } from '../../src/react/components/ai-chat-panel.js';
import { defineChatCommand, defineChatEntity } from '../../src/react/interactions/definitions.js';
import { AiChatProvider } from '../../src/react/provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport } from '../../src/react/types.js';

const sent: string[] = [];
// Not declared as a global `Window` property: other browser fixtures declare
// `window.harness` with their own types in the same `typecheck:tests` program.
Object.assign(window, { interactionsHarness: { sent } });

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { de: 'Aufgaben filtern', en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen', description: 'open' }, { id: '8', label: 'Report schreiben' }]
    .filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  actions: [
    { id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
    { id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
  ],
});

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
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

const noop = () => {};

function useRecordingTransport(): ChatTransport {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const sendMessage = useCallback(async ({ text }: { text: string }) => {
    sent.push(text);
    setMessages((previous) => [...previous, { id: `user-${previous.length}`, role: 'user', parts: [{ type: 'text', text }] }]);
  }, []);
  return useMemo<ChatTransport>(() => ({
    messages, status: 'ready', error: null, sendMessage, stop: noop, setMessages, addToolApprovalResponse: noop,
  }), [messages, sendMessage]);
}

function ReactView() {
  const transport = useRecordingTransport();
  const interactions = useMemo(() => ({ data, entities: [task, person], commands: [assign] }), []);
  return (
    <div style={{ height: 640 }}>
      <AiChatProvider transport={transport} chatInteractions={interactions}>
        <AiChatPanel />
      </AiChatProvider>
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'react';
const root = document.getElementById('root')!;
if (view === 'embed') {
  defineGlirastesChatElement();
  const element = document.createElement('glirastes-chat') as GlirastesChatElement;
  element.style.display = 'block';
  element.style.height = '640px';
  element.transport = {
    messages: [], status: 'ready', error: null,
    async sendMessage({ text }) { sent.push(text); },
    stop: noop, setMessages: noop, addToolApprovalResponse: noop,
  };
  element.interactions = data;
  element.defineEntity(task);
  element.defineEntity(person);
  element.defineCommand(assign);
  root.append(element);
} else {
  createRoot(root).render(<ReactView />);
}
