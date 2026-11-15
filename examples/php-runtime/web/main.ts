import { defineGlirastesChatElement } from 'glirastes/embed';
import { registerAiClientAction } from 'glirastes/browser';
import { createLocalSessionStore } from 'glirastes/react';
import { z } from 'zod';

registerAiClientAction('tasks.highlight', ({ taskId }) => {
  const task = document.getElementById(taskId);
  if (!task) throw new Error('Task is not on this page');
  task.dataset.highlighted = 'true';
  task.style.backgroundColor = '#fff2a8';
}, z.object({ taskId: z.string() }).strict());

const identity = await fetch('/api/me').then((response) => {
  if (!response.ok) throw new Error('Sign in through the fixture login endpoint first');
  return response.json();
});
document.getElementById('identity')!.textContent = `${identity.tenantId} / ${identity.userId}`;
const { tasks } = await fetch('/api/tasks').then((response) => response.json());
for (const task of tasks) {
  const item = document.createElement('li');
  item.id = task.id;
  item.textContent = task.title;
  document.getElementById('tasks')!.append(item);
}
// Install verified-user persistence before mounting, so the provider's initial
// load cannot run against an unconfigured/default session.
defineGlirastesChatElement();
const chat = document.createElement('glirastes-chat');
chat.setAttribute('endpoint', '/glirastes/chat');
chat.setAttribute('theme', 'light');
chat.setAttribute('placeholder', 'Ask about your tasks');
chat.config = {
  session: createLocalSessionStore({ storageKey: JSON.stringify(['php-runtime', 'local', identity.tenantId, identity.userId]) }),
};
document.getElementById('chat')!.append(chat);
