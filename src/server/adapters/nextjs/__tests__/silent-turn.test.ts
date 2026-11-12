import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { TechnicalRuntimeEventV2 } from '../../../../contracts/index.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 12_000, noCache: 12_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 13, text: 0, reasoning: 13 },
};

function silentStep(kind: 'reasoning-only' | 'empty-text') {
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
