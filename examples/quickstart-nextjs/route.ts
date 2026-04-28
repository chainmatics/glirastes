import { openai } from '@ai-sdk/openai';
import { endpointToolsToRegistry } from 'glirastes/server';
import { createAiChatHandler } from 'glirastes/server/nextjs';
import { listTasks } from './ai-tools.js';

export const POST = createAiChatHandler({
  tools: endpointToolsToRegistry([listTasks]),
  model: openai('gpt-4o-mini'),
  systemPrompt: 'You are a task assistant.',
});
