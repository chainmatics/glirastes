import { randomBytes, randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { createMemoryPrivacyMappingStore, type PrivacyKeyring, type PrivacyScope } from '../mapping-store.js';
import { createStrictPiiShield, type StrictPiiShieldConfig } from '../strict-shield.js';

/** Synthetic canaries: never real people or data. */
export const CANARY = {
  name: 'Anna Muster',
  firstName: 'Anna',
  lastName: 'Muster',
  userId: 'user-17',
  uuid: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
  email: 'anna@example.invalid',
  colleague: 'Bernd Beispiel',
  colleagueId: 'u-4711',
  colleagueEmail: 'bernd.beispiel@example.invalid',
} as const;

export const CANARY_PATTERN = /Anna Muster|Muster|user-17|anna@example\.invalid|Bernd Beispiel|Beispiel|u-4711|bernd\.beispiel@example\.invalid|6f9619ff-8b86-4d11-b42d-00c04fc964ff/;

export function testScope(overrides: Partial<PrivacyScope> = {}): PrivacyScope {
  return {
    tenantId: 'tenant-a',
    appId: 'app-test',
    environment: 'test',
    principalId: 'principal-1',
    conversationId: `conv-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
}

export function testKeyring(extra: Partial<PrivacyKeyring> = {}): PrivacyKeyring {
  return {
    activeKeyId: 'k1',
    keys: { k1: randomBytes(32) },
    indexKey: randomBytes(32),
    ...extra,
  };
}

export function memoryShield(config: Partial<StrictPiiShieldConfig> = {}) {
  const store = config.store ?? createMemoryPrivacyMappingStore();
  return createStrictPiiShield({ locale: 'de-DE', allowEphemeralStore: true, ...config, store });
}

/** A V3 mock model that records every call it receives. */
export function captureModel(responses: Array<{ text?: string; toolCall?: { name: string; input: unknown } }> = [{ text: 'ok' }]) {
  const calls: LanguageModelV3CallOptions[] = [];
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)]!;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      const r = next();
      return {
        content: r.toolCall
          ? [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: r.toolCall.name, input: JSON.stringify(r.toolCall.input) }]
          : [{ type: 'text', text: r.text ?? '' }],
        finishReason: { unified: r.toolCall ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      calls.push(options);
      const r = next();
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (r.toolCall) {
        parts.push({ type: 'tool-call', toolCallId: `call-${index}`, toolName: r.toolCall.name, input: JSON.stringify(r.toolCall.input) });
      } else {
        const text = r.text ?? '';
        const half = Math.floor(text.length / 2);
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text.slice(0, half) }, { type: 'text-delta', id: 't', delta: text.slice(half) }, { type: 'text-end', id: 't' });
      }
      parts.push({
        type: 'finish',
        finishReason: { unified: r.toolCall ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      } as never);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  return { model: model as unknown as LanguageModelV3, calls };
}

export interface CapturedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A fetch that records the final HTTP request and answers like the provider would. */
export function captureFetch(kind: 'openai-chat' | 'anthropic', options: { failFirst?: boolean; text?: string } = {}) {
  const requests: CapturedRequest[] = [];
  let failed = false;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    requests.push({ url: String(input), body, headers });
    if (options.failFirst && !failed) {
      failed = true;
      return new Response(JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const stream = JSON.parse(body || '{}').stream === true;
    const text = options.text ?? 'Erledigt.';
    if (kind === 'openai-chat') {
      if (stream) {
        const events = [
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (stream) {
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ] as const;
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** Two genuinely different provider adapters over a captured transport. */
export function providerAdapters(text?: string) {
  const openrouter = captureFetch('openai-chat', { text });
  const anthropic = captureFetch('anthropic', { text });
  return {
    openrouter: {
      ...openrouter,
      model: createOpenAI({ baseURL: 'https://openrouter.example.invalid/api/v1', apiKey: 'test-key-openrouter', fetch: openrouter.fetch }).chat('openai/gpt-4o-mini'),
    },
    anthropic: {
      ...anthropic,
      model: createAnthropic({ baseURL: 'https://anthropic.example.invalid/v1', apiKey: 'test-key-anthropic', fetch: anthropic.fetch })('claude-sonnet-4-5'),
    },
  };
}
