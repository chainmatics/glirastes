import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { prepareModelMessages } from '../prepare-model-messages.js';

type Part = Record<string, unknown>;

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

const assistant = (id: string, parts: Part[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as UIMessage;

const toolPart = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output,
});

function toolResults(messages: unknown[]) {
  return (messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Part[]);
}

describe('prepareModelMessages', () => {
  it('strips uiAction from AI SDK 6 json tool outputs', async () => {
    const messages = await prepareModelMessages([
      user('u1', 'Neue Aufgabe'),
      assistant('a1', [{ type: 'step-start' }, toolPart('tasks_create', 'c1', {}, { id: 't1', uiAction: { type: 'toast' } })]),
    ]);
    const [result] = toolResults(messages);
    expect(result).toMatchObject({ output: { type: 'json', value: { id: 't1' } } });
    expect(JSON.stringify(messages)).not.toContain('uiAction');
  });

});
