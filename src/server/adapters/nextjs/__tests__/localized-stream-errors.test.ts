import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import {
  GENERIC_STREAM_ERROR_TEXT,
  INVALID_TOOL_INPUT_TEXT,
  resolveStreamErrorTexts,
} from '../stream-error-text.js';

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
