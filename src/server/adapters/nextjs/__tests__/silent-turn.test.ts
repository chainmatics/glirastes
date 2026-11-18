import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { TechnicalRuntimeEventV2 } from '../../../../contracts/index.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 12_000, noCache: 12_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 13, text: 0, reasoning: 13 },
};

function silentStep(kind: 'reasoning-only' | 'empty-text'): ReadableStream {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    ...(kind === 'reasoning-only'
      ? [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
          { type: 'reasoning-end', id: 'r1' },
        ]
      : [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: '  ' },
          { type: 'text-end', id: 't1' },
        ]),
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ] as never);
}

function metricsSink() {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: '019fb900-0000-7000-8000-0000000000a1',
      environmentId: '019fb900-0000-7000-8000-0000000000e1',
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
    },
    record: (event) => {
      if (event.eventType !== 'tool_contract_rejected') events.push(event);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

function request() {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'bitte den Filter von eben' }],
    }] }),
  });
}

describe('a turn whose model returns no visible output', () => {
  it.each(['reasoning-only', 'empty-text'] as const)(
    '%s: answers with a fallback text and reports the turn as a model error',
    async (kind) => {
      const { sink, events } = metricsSink();
      const handler = createAiChatHandler({
        tools: {},
        model: new MockLanguageModelV3({ doStream: async () => ({ stream: silentStep(kind) }) }),
        systemPrompt: 'Assistant',
        locale: 'de-DE',
        metrics: sink,
      });

      const wire = await (await handler(request())).text();

      expect(wire).toContain('"type":"text-delta"');
      expect(wire).toContain('keine Antwort');
      expect(wire.indexOf('keine Antwort')).toBeLessThan(wire.indexOf('"type":"finish"'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'error', errorCode: 'model_error' });
    },
  );
});

describe('the handler texts in the language of a request', () => {
  const handlerWith = (extra: Record<string, unknown>) => createAiChatHandler({
    tools: {},
    model: new MockLanguageModelV3({ doStream: async () => ({ stream: silentStep('empty-text') }) }),
    systemPrompt: 'Assistant',
    ...extra,
  });
  const withLanguage = (language: string) => {
    const base = request();
    return new Request(base, { headers: { 'content-type': 'application/json', 'x-app-language': language } });
  };
  const pl = { silentTurn: 'Nie udało mi się odpowiedzieć.' };

  it('answers in the app table of the request language, per key falling back to the built-in texts', async () => {
    const handler = handlerWith({ requestLocale: (req: Request) => req.headers.get('x-app-language') ?? undefined, locales: { pl } });
    expect(await (await handler(withLanguage('pl-PL'))).text()).toContain('Nie udało mi się odpowiedzieć.');
    expect(await (await handler(withLanguage('de-AT'))).text()).toContain('keine Antwort');
    expect(await (await handler(withLanguage('fr'))).text()).toContain('I did not produce an answer');
    // No language tag, or a throwing resolver: the configured locale.
    expect(await (await handler(withLanguage('de_DE; drop'))).text()).toContain('I did not produce an answer');
    const throwing = handlerWith({ locale: 'de-DE', requestLocale: () => { throw new Error('no profile'); } });
    expect(await (await throwing(withLanguage('pl'))).text()).toContain('keine Antwort');
  });

  it('keeps the configured locale for every turn without requestLocale', async () => {
    const handler = handlerWith({ locale: 'pl', locales: { pl } });
    expect(await (await handler(withLanguage('de'))).text()).toContain('Nie udało mi się odpowiedzieć.');
  });

  it('refuses an invalid table when the handler is created', () => {
    expect(() => handlerWith({ locales: { de_DE: pl } })).toThrow('locales.de_DE is not a BCP-47 language tag');
    expect(() => handlerWith({ locales: { pl: { sendButton: 'Wyślij' } } })).toThrow('locales.pl.sendButton is not a text key');
    expect(() => handlerWith({ locales: { pl: { closing: ' ' } } })).toThrow('must be a non-empty string');
  });
});
