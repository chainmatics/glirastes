import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { prepareModelMessages } from '../prepare-model-messages.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { DEFAULT_BUDGET_STOP_TEXTS, resolveBudgetStopTexts } from '../budget-stop-notice.js';
import { resolveChatServerTexts } from '../chat-texts.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  GENERIC_STREAM_ERROR_TEXT,
  INVALID_TOOL_INPUT_HISTORY_TEXT,
  INVALID_TOOL_INPUT_TEXT,
  INVALID_TOOL_INPUT_TEXT_DE,
} from '../stream-error-text.js';
import { agentRevision, localLimits, manifestRevision, policyRevision, principal, streamChunks } from './command-fixtures.js';

const request = (locale?: string) => new Request('http://localhost/api/ai/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...(locale ? { locale } : {}), messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }),
});
const failingModel = () => new MockLanguageModelV3({ doStream: async () => { throw new Error('boom'); } });

describe('stream error texts in the server locale table', () => {
  const texts = (locale: string | undefined, locales?: Parameters<typeof resolveChatServerTexts>[2]) => resolveChatServerTexts(locale, undefined, locales);
  it('is German for de* and English otherwise', () => {
    expect(texts('de-DE').streamError).toBe('KI-Anfrage fehlgeschlagen');
    expect(texts('de').invalidToolInput).toBe(INVALID_TOOL_INPUT_TEXT_DE);
    expect(texts('en-US').streamError).toBe(GENERIC_STREAM_ERROR_TEXT);
    expect(texts('en-US').invalidToolInput).toBe(INVALID_TOOL_INPUT_TEXT);
    expect(texts(undefined).streamError).toBe(GENERIC_STREAM_ERROR_TEXT);
    expect(texts('fr-FR').streamError).toBe(GENERIC_STREAM_ERROR_TEXT);
  });
  it('lets a locale table change single texts of a language or add one', () => {
    expect(texts('de-DE', { de: { streamError: 'Fehler' } })).toMatchObject({
      streamError: 'Fehler',
      invalidToolInput: INVALID_TOOL_INPUT_TEXT_DE,
    });
    expect(texts('fr-FR', { fr: { streamError: 'La requête a échoué' } }).streamError).toBe('La requête a échoué');
    expect(texts('en-US', { fr: { streamError: 'La requête a échoué' } }).streamError).toBe(GENERIC_STREAM_ERROR_TEXT);
  });
});

describe('localized stream failure text in the handler', () => {
  it('German chat gets the German generic failure text', async () => {
    const handler = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'de-DE', onError: vi.fn() });
    const body = await (await handler(request())).text();
    expect(body).toContain('KI-Anfrage fehlgeschlagen');
    expect(body).not.toContain('AI request failed');
  });
  it('detects German like the budget stop notice, also for a locale that is no language tag', async () => {
    for (const locale of ['deu', 'deutsch']) {
      expect(resolveBudgetStopTexts(locale, undefined)).toBe(DEFAULT_BUDGET_STOP_TEXTS.de);
      const handler = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale, onError: vi.fn() });
      expect(await (await handler(request())).text(), locale).toContain('KI-Anfrage fehlgeschlagen');
    }
  });
  it('English chat keeps the English text', async () => {
    const handler = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'en-US', onError: vi.fn() });
    expect(await (await handler(request())).text()).toContain('AI request failed');
  });
  it('a locales text of the turn language wins', async () => {
    const handler = createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'de-DE', onError: vi.fn(),
      locales: { de: { streamError: 'Etwas ging schief' } },
    });
    expect(await (await handler(request())).text()).toContain('Etwas ging schief');
  });
  it('another language gets English unless locales adds it', async () => {
    const plain = createAiChatHandler({ tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'fr-FR', onError: vi.fn() });
    expect(await (await plain(request())).text()).toContain('AI request failed');
    const french = createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'fr-FR', onError: vi.fn(),
      locales: { fr: { streamError: 'La requête a échoué' } },
    });
    expect(await (await french(request())).text()).toContain('La requête a échoué');
  });
  it('the 500 JSON body before streaming stays English', async () => {
    const handler = createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locale: 'de-DE', onError: vi.fn(),
      locales: { de: { streamError: 'Etwas ging schief' } },
      streamHandler: () => { throw new Error('boom'); },
    });
    const response = await handler(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'AI request failed' });
  });
  it('throws at creation for an unknown or empty locales text', () => {
    expect(() => createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locales: { de: { bogus: 'x' } as never },
    })).toThrow(/locales\.de\.bogus is not a text key/);
    expect(() => createAiChatHandler({
      tools: {}, systemPrompt: 'A', model: failingModel(), locales: { de: { streamError: ' ' } },
    })).toThrow(/locales\.de\.streamError must be a non-empty string/);
  });
  it('has no separate streamErrorTexts option', () => {
    // @ts-expect-error the stream error texts live in `locales`
    const config: AiChatHandlerConfig = { tools: {}, systemPrompt: 'A', streamErrorTexts: { generic: 'x' } };
    expect(config).toBeDefined();
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
  it('the handler swaps a locales invalidToolInput text of any language for the English history text', async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never),
      }),
    });
    const handler = createAiChatHandler({
      tools: { tasks_list: defineTool({ id: 'tasks.list', description: 'List.', inputSchema: z.object({}).strict(), execute: async () => ({}) }) },
      systemPrompt: 'A', model, locale: 'de-DE', onError: vi.fn(), resultHandles: false,
      locales: { pl: { invalidToolInput: 'Nieprawidłowe dane' } },
    });
    await (await handler(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history('Nieprawidłowe dane') }),
    }))).text();
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain(JSON.stringify(INVALID_TOOL_INPUT_HISTORY_TEXT).slice(1, 40));
    expect(prompt).not.toContain('Nieprawidłowe dane');
  });
  it('an unrelated text is kept', async () => {
    const prompt = await prepareModelMessages(history('Bitte nochmal') as never) as never;
    expect(JSON.stringify(prompt)).toContain('Bitte nochmal');
  });
});

describe('the kind of a localized failure text for the activity log (data-step-failure)', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  /** One turn whose model calls `tasks_list` once with `input`; the tool times out (generic failure). */
  async function turn(input: unknown, config: Partial<AiChatHandlerConfig>) {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: call++ === 0
          ? convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'tasks_list', input: JSON.stringify(input) },
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
          execute: () => new Promise((resolve) => setTimeout(() => resolve({ tasks: [] }), 500)),
        }),
      },
      systemPrompt: 'A', model, onError: vi.fn(), resultHandles: false,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
          localLimits: { ...localLimits, toolTimeoutMs: 20 },
        }),
        loadRevocations: async () => [],
      },
      ...config,
    });
    const chunks = await streamChunks(await handler(request()));
    return {
      errorTexts: chunks.filter((chunk) => chunk.type === 'tool-output-error' || chunk.type === 'tool-input-error')
        .map((chunk) => chunk.errorText),
      kinds: chunks.filter((chunk) => chunk.type === 'data-step-failure').map((chunk) => ({ id: chunk.id, data: chunk.data })),
      order: chunks.map((chunk) => chunk.type).filter((type) => type === 'tool-output-error' || type === 'data-step-failure'),
    };
  }

  it('a German turn names the generic failure right after its errorText', async () => {
    const result = await turn({ query: 'q' }, { locale: 'de-DE' });
    expect(result.errorTexts).toEqual(['KI-Anfrage fehlgeschlagen']);
    expect(result.kinds).toEqual([{ id: 'c1', data: { toolCallId: 'c1', code: 'failed' } }]);
    expect(result.order).toEqual(['tool-output-error', 'data-step-failure']);
  });
  it('a German turn names invalid tool input once, with the activity log\'s German wording', async () => {
    const result = await turn({}, { locale: 'de-DE' });
    expect(new Set(result.errorTexts)).toEqual(new Set([INVALID_TOOL_INPUT_TEXT_DE]));
    expect(INVALID_TOOL_INPUT_TEXT_DE).toBe('Der Assistent hat ungültige Angaben für dieses Tool gesendet; ihm wurde gesagt, was zu korrigieren ist.');
    expect(result.kinds).toEqual([{ id: 'c1', data: { toolCallId: 'c1', code: 'invalid-input' } }]);
  });
  it('an English turn streams exactly as before: no part', async () => {
    expect((await turn({ query: 'q' }, { locale: 'en-US' })).kinds).toEqual([]);
    expect((await turn({}, { locale: 'en-US' })).kinds).toEqual([]);
  });
  it('an own locales text is named too, in any language', async () => {
    const result = await turn({}, { locale: 'en-US', locales: { en: { invalidToolInput: 'Bad arguments, retrying' } } });
    expect(result.errorTexts).toContain('Bad arguments, retrying');
    expect(result.kinds).toEqual([{ id: 'c1', data: { toolCallId: 'c1', code: 'invalid-input' } }]);
    const failed = await turn({ query: 'q' }, { locale: 'fr-FR', locales: { fr: { streamError: 'La requête a échoué' } } });
    expect(failed.kinds).toEqual([{ id: 'c1', data: { toolCallId: 'c1', code: 'failed' } }]);
  });
  it('the part stays out of the model\'s history', async () => {
    const prompt = await prepareModelMessages([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'step-start' },
        { type: 'tool-tasks_list', toolCallId: 'c1', state: 'output-error', rawInput: {}, errorText: 'KI-Anfrage fehlgeschlagen' },
        { type: 'data-step-failure', id: 'c1', data: { toolCallId: 'c1', code: 'failed' } },
      ] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Again' }] },
    ] as never);
    expect(JSON.stringify(prompt)).not.toContain('step-failure');
    expect(JSON.stringify(prompt)).not.toContain('"code"');
  });
  it('one own text for both kinds names neither', async () => {
    const result = await turn({}, { locale: 'de-DE', locales: { de: { streamError: 'Fehler', invalidToolInput: 'Fehler' } } });
    expect(result.errorTexts).toContain('Fehler');
    expect(result.kinds).toEqual([]);
  });
});
