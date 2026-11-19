import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { prepareModelMessages } from '../prepare-model-messages.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import {
  GENERIC_STREAM_ERROR_TEXT,
  INVALID_TOOL_INPUT_HISTORY_TEXT,
  INVALID_TOOL_INPUT_TEXT,
  INVALID_TOOL_INPUT_TEXT_DE,
  resolveStreamErrorTexts,
} from '../stream-error-text.js';
import { agentRevision, localLimits, manifestRevision, policyRevision, principal, streamChunks } from './command-fixtures.js';

const request = (locale?: string) => new Request('http://localhost/api/ai/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...(locale ? { locale } : {}), messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }),
});
const failingModel = () => new MockLanguageModelV3({ doStream: async () => { throw new Error('boom'); } });

describe('resolveStreamErrorTexts', () => {
  it('is German for de* and English otherwise', () => {
    expect(resolveStreamErrorTexts('de-DE').generic).toBe('KI-Anfrage fehlgeschlagen');
    expect(resolveStreamErrorTexts('en-US').generic).toBe(GENERIC_STREAM_ERROR_TEXT);
    expect(resolveStreamErrorTexts('en-US').invalidToolInput).toBe(INVALID_TOOL_INPUT_TEXT);
    expect(resolveStreamErrorTexts(undefined).generic).toBe(GENERIC_STREAM_ERROR_TEXT);
  });
  it('lets overrides win', () => {
    expect(resolveStreamErrorTexts('de', { generic: 'Fehler' })).toEqual({
      generic: 'Fehler',
      invalidToolInput: resolveStreamErrorTexts('de').invalidToolInput,
    });
  });
  it('throws for an unknown key or an empty text', () => {
    expect(() => resolveStreamErrorTexts('de', { nope: 'x' } as never)).toThrow(/streamErrorTexts\.nope is not a text key/);
    expect(() => resolveStreamErrorTexts('de', { generic: ' ' })).toThrow(/non-empty string/);
  });
});

describe('localized stream failure text in the handler', () => {
  it('German chat gets the German generic failure text', async () => {
    const handler = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'de-DE', onError: vi.fn() });
    const body = await (await handler(request())).text();
    expect(body).toContain('KI-Anfrage fehlgeschlagen');
    expect(body).not.toContain('AI request failed');
  });
  it('English chat keeps the English text', async () => {
    const handler = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'en-US', onError: vi.fn() });
    expect(await (await handler(request())).text()).toContain('AI request failed');
  });
  it('streamErrorTexts override wins', async () => {
    const handler = createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'de-DE', onError: vi.fn(),
      streamErrorTexts: { generic: 'Etwas ging schief' },
    });
    expect(await (await handler(request())).text()).toContain('Etwas ging schief');
  });
  it('throws at creation for an unknown streamErrorTexts key', () => {
    expect(() => createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), streamErrorTexts: { bogus: 'x' } as never,
    })).toThrow(/streamErrorTexts\.bogus/);
  });
});

describe('tool card failure text', () => {
  it('a German chat whose tool fails with an unnamed error streams exactly the German text as tool errorText', async () => {
    let call = 0;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: call++ === 0
          ? convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'tasks_list', input: JSON.stringify({ query: 'q' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ] as never)
          : convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ] as never),
      }),
    });
    const handler = createAiChatHandler({
      tools: {
        tasks_list: defineTool({
          id: 'tasks.list', description: 'Fails.', inputSchema: z.object({ query: z.string() }).strict(),
          // A thrown Error is caught by the tool wrapper and returned as a result; a timeout reaches the stream's error mask.
          execute: () => new Promise((resolve) => setTimeout(() => resolve({ tasks: [] }), 500)),
        }),
      },
      systemPrompt: 'A', model, locale: 'de-DE', onError: vi.fn(), resultHandles: false,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
          localLimits: { ...localLimits, toolTimeoutMs: 20 },
        }),
        loadRevocations: async () => [],
      },
    });
    const chunks = await streamChunks(await handler(request()));
    const failed = chunks.filter((chunk) => chunk.type === 'tool-output-error');
    expect(failed.map((chunk) => chunk.errorText)).toEqual(['KI-Anfrage fehlgeschlagen']);
    expect(JSON.stringify(chunks)).not.toContain('timed out');
  });
});

describe('invalid-input history swap with localized and overridden texts', () => {
  const history = (errorText: string) => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show' }] },
    { id: 'a1', role: 'assistant', parts: [
      { type: 'step-start' },
      { type: 'tool-tasks_list', toolCallId: 'call-1', state: 'output-error', rawInput: {}, errorText },
    ] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Again' }] },
  ];
  const toolOutputs = (prompt: Array<{ role: string; content: unknown }>) => prompt.filter((m) => m.role === 'tool')
    .flatMap((m) => (m.content as Array<{ output: unknown }>).map((part) => part.output));

  it('the German built-in text becomes the English history text', async () => {
    const prompt = await prepareModelMessages(history(INVALID_TOOL_INPUT_TEXT_DE) as never) as never;
    expect(toolOutputs(prompt)).toEqual([{ type: 'error-text', value: INVALID_TOOL_INPUT_HISTORY_TEXT }]);
  });
  it('a configured override becomes the English history text when passed', async () => {
    const prompt = await prepareModelMessages(history('Bitte nochmal') as never, { invalidToolInputTexts: ['Bitte nochmal'] }) as never;
    expect(toolOutputs(prompt)).toEqual([{ type: 'error-text', value: INVALID_TOOL_INPUT_HISTORY_TEXT }]);
    expect(JSON.stringify(prompt)).not.toContain('Bitte nochmal');
  });
  it('an unrelated text is kept', async () => {
    const prompt = await prepareModelMessages(history('Bitte nochmal') as never) as never;
    expect(JSON.stringify(prompt)).toContain('Bitte nochmal');
  });
});
