import { generateText, readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type ModuleDefinition, type ToolRegistry } from '../../../../types.js';
import { createLocalAiPipeline } from '../../../local-pipeline.js';
import type { ChatPrivacyConfig } from '../../../pii-shield/chat-privacy.js';
import { PrivacyError } from '../../../pii-shield/detection-result.js';
import { CANARY, CANARY_PATTERN, memoryShield, providerAdapters, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

const SECRET = 'privacy-handler-test-secret-32-chars!';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function lastUserText(prompt: LanguageModelV3Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== 'user') continue;
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

/**
 * Step 1: calls `tool` with the first e-mail address of the latest user
 * text (a pseudonym, as the model only sees those); afterwards echoes the
 * user's text.
 */
function echoModel(tool?: string) {
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls.push(options);
      const text = lastUserText(options.prompt);
      const email = text.match(/[\w.+-]+@[\w.-]+/)?.[0];
      const callTool = tool && calls.length === 1 && email;
      return {
        stream: convertArrayToReadableStream((callTool
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: tool, input: JSON.stringify({ to: email }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: `Echo: ${text.slice(0, 7)}` },
            { type: 'text-delta', id: 't1', delta: text.slice(7) },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]) as never),
      };
    },
  });
  return { model, calls };
}

function registry(needsApproval = false) {
  const send = vi.fn(async (input: { to: string }) => ({ success: true, sentTo: input.to }));
  const tools: ToolRegistry = {
    mail_send: defineTool({
      id: 'mail.send', description: `Sendet eine Mail im Namen von ${CANARY.name}.`,
      inputSchema: z.object({ to: z.string() }).strict(), needsApproval, execute: send,
    }),
  };
  return { tools, send };
}

function privacyConfig(extra: Partial<ChatPrivacyConfig> = {}): ChatPrivacyConfig {
  const scope = testScope({ conversationId: 'chat-1' });
  return {
    shield: memoryShield(),
    scope: (_req, chat) => (chat.conversationId ? { ...scope, conversationId: chat.conversationId } : null),
    knownIdentities: () => [
      { id: CANARY.userId, name: CANARY.name, email: CANARY.email },
      { id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail },
    ],
    ...extra,
  };
}

const user = (text: string, id = 'u1', parts: unknown[] = []) => ({ id, role: 'user', parts: [{ type: 'text', text }, ...parts] });
const post = (messages: unknown[], id: string | null = 'chat-1') => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(id ? { id } : {}), messages }),
});
const SYSTEM = `Du hilfst ${CANARY.name} (${CANARY.userId}, ${CANARY.email}).`;

function shownText(chunks: Array<Record<string, unknown>>): string {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
}

async function clientMessage(chunks: Array<Record<string, unknown>>): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: convertArrayToReadableStream(chunks as never) })) last = message;
  return JSON.parse(JSON.stringify(last)) as UIMessage;
}

describe('protected chat turn (legacy mode)', () => {
  it('the model sees pseudonyms only; the principal sees the originals', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, privacy: privacyConfig() });
    const response = await handler(post([user(`Schreib an ${CANARY.colleague}, ${CANARY.colleagueEmail}`)]));
    expect(response.status).toBe(200);
    const chunks = await streamChunks(response);
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
    expect(shownText(chunks)).toBe(`Echo: Schreib an ${CANARY.colleague}, ${CANARY.colleagueEmail}`);
    const status = chunks.find((c) => c.type === 'data-privacy-status');
    expect(status).toMatchObject({ data: { profile: 'protected-text/v1', screenshots: 'blocked' } });
  });

  it('tool input is rehydrated for execution; the next step sees the protected result', async () => {
    const { tools, send } = registry();
    const { model, calls } = echoModel('mail_send');
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, privacy: privacyConfig() });
    const chunks = await streamChunks(await handler(post([user(`Mail an ${CANARY.colleagueEmail}`)])));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ to: CANARY.colleagueEmail });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
    const input = chunks.find((c) => c.type === 'tool-input-available');
    expect(input).toMatchObject({ input: { to: CANARY.colleagueEmail } });
    expect(chunks.some((c) => c.type === 'tool-input-delta')).toBe(false);
  });

  it('an approval binds to the originals the principal saw and executes once', async () => {
    const { tools, send } = registry(true);
    const { model, calls } = echoModel('mail_send');
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, approvalSecret: SECRET, privacy: privacyConfig() });
    const first = await streamChunks(await handler(post([user(`Mail an ${CANARY.colleagueEmail}`)])));
    const request = first.find((c) => c.type === 'tool-approval-request');
    expect(request).toBeDefined();
    expect(send).not.toHaveBeenCalled();
    const message = await clientMessage(first);
    const approved = JSON.parse(JSON.stringify({
      ...message,
      parts: message.parts.map((part) => {
        const record = part as Record<string, unknown>;
        return record.state === 'approval-requested'
          ? { ...record, state: 'approval-responded', approval: { id: (record.approval as { id: string }).id, approved: true } }
          : part;
      }),
    }));
    const second = await handler(post([user(`Mail an ${CANARY.colleagueEmail}`), approved]));
    expect(second.status).toBe(200);
    const chunks = await streamChunks(second);
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({ toolCallId: 'call-1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ to: CANARY.colleagueEmail });
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
  });

  it('a later turn with displayed history sends no original to the model', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const privacy = privacyConfig();
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, privacy });
    const first = await streamChunks(await handler(post([user(`Wer ist ${CANARY.colleague}?`)])));
    const assistant = await clientMessage(first);
    expect(JSON.stringify(assistant)).toContain(CANARY.colleague);
    await streamChunks(await handler(post([user(`Wer ist ${CANARY.colleague}?`), assistant, user('Und seine Mail?', 'u2')])));
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
  });
});

describe('real provider transport through the handler', () => {
  for (const kind of ['openrouter', 'anthropic'] as const) {
    it(`${kind}: the HTTP body carries no original`, async () => {
      const adapters = providerAdapters();
      const { tools } = registry();
      const handler = createAiChatHandler({ tools, model: adapters[kind].model, systemPrompt: SYSTEM, privacy: privacyConfig() });
      const response = await handler(post([user(`Schreib ${CANARY.colleague} an ${CANARY.colleagueEmail}`)]));
      expect(response.status).toBe(200);
      await streamChunks(response);
      expect(adapters[kind].requests).toHaveLength(1);
      expect(adapters[kind].requests[0]!.body).not.toMatch(CANARY_PATTERN);
      expect(adapters[kind].requests[0]!.body).toContain('mail_send');
    });
  }
});

describe('fail-closed refusals', () => {
  it('refuses incompatible configurations at construction', () => {
    const { tools } = registry();
    const { model } = echoModel();
    const privacy = privacyConfig();
    expect(() => createAiChatHandler({ tools, model, privacy, piiShield: {} } as never)).toThrow(/replaces piiShield/);
    expect(() => createAiChatHandler({ tools, model, privacy, lancer: {} } as never)).toThrow(/lancer or telemetry/);
    expect(() => createAiChatHandler({ tools, model, privacy, telemetry: { emit() {}, flush: async () => {} } } as never)).toThrow(/lancer or telemetry/);
    expect(() => createAiChatHandler({ tools, model, privacy, pipeline: { process: async () => ({}) } } as never)).toThrow(/createLocalAiPipeline/);
  });

  it('answers 401 without an authenticated scope and never calls the model', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, privacy: privacyConfig() });
    const response = await handler(post([user('Hallo')], null));
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('a detector failure answers a content-free 503 and the error callback gets no content', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const onError = vi.fn();
    const shield = memoryShield({ detectors: [{ detect: () => { throw new Error(`saw ${CANARY.email}`); } }] });
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, onError, privacy: privacyConfig({ shield }) });
    const response = await handler(post([user(`Mail ${CANARY.email}`)]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'privacy_detector_unavailable' });
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    expect(JSON.stringify(onError.mock.calls.map(([e]) => ({ name: e.name, code: e.code, message: e.message })))).not.toMatch(CANARY_PATTERN);
  });

  it('a model that leaks an original ends the stream with a privacy code, not the text', async () => {
    const { tools } = registry();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: `Die Mail ist ${CANARY.email}` },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never),
      }),
    });
    const onError = vi.fn();
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, onError, privacy: privacyConfig() });
    const chunks = await streamChunks(await handler(post([user('Wie ist meine Mail?')])));
    expect(JSON.stringify(chunks)).not.toContain(CANARY.email);
    expect(chunks.find((c) => c.type === 'error')).toMatchObject({ errorText: 'privacy_output_leak' });
  });

  it('a thrown tool error reaches neither the model nor the callbacks with content', async () => {
    const onToolError = vi.fn();
    const tools: ToolRegistry = {
      mail_send: defineTool({
        id: 'mail.send', description: 'Send.', inputSchema: z.object({ to: z.string() }).strict(), needsApproval: false,
        execute: async () => { throw new Error(`SMTP 550 for ${CANARY.colleagueEmail}`); },
      }),
    };
    const { model, calls } = echoModel('mail_send');
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, onToolError, privacy: privacyConfig() });
    await streamChunks(await handler(post([user(`Mail an ${CANARY.colleagueEmail}`)])));
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
    expect(JSON.stringify(calls[1]!.prompt)).not.toContain('SMTP');
    expect(onToolError).toHaveBeenCalled();
    expect(String(onToolError.mock.calls[0]![1].message)).not.toMatch(CANARY_PATTERN);
  });
});

describe('screenshots', () => {
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`;
  const shot = { type: 'file', mediaType: 'image/png', url: png, filename: `${CANARY.name}.png` };

  it('blocked by default: a screenshot in the new message is refused before any model call', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({ tools, model, systemPrompt: SYSTEM, attachments: { enabled: true }, privacy: privacyConfig() });
    const response = await handler(post([user('Siehe Bild', 'u1', [shot])]));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'privacy_attachment_blocked' });
    expect(calls).toHaveLength(0);
  });

  it('a browser-chosen allow-original cannot widen a blocked app rule', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: SYSTEM, attachments: { enabled: true },
      privacy: privacyConfig({ attachments: () => ({ app: 'blocked', user: 'allow-original' }) }),
    });
    expect((await handler(post([user('Bild', 'u1', [shot])]))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('allow-original with a vision model passes the image unchanged and shows the notice', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: SYSTEM, attachments: { enabled: true },
      privacy: privacyConfig({ attachments: () => ({ app: 'allow-original', tenant: 'allow-original' }), modelCapabilities: { images: true } }),
    });
    const chunks = await streamChunks(await handler(post([user('Bild', 'u1', [shot])])));
    const files = calls[0]!.prompt.flatMap((m): unknown[] => (Array.isArray(m.content) ? [...m.content] : [])).filter((p) => (p as { type: string }).type === 'file');
    expect(files).toHaveLength(1);
    expect(JSON.stringify(files)).not.toContain(CANARY.name);
    expect(chunks.find((c) => c.type === 'data-privacy-status')).toMatchObject({ data: { label: 'Text geschützt; Screenshots werden im Original übertragen' } });
  });

  it('allow-original with a text-only model refuses the screenshot visibly', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: SYSTEM, attachments: { enabled: true },
      privacy: privacyConfig({ attachments: () => ({ app: 'allow-original' }) }),
    });
    const response = await handler(post([user('Bild', 'u1', [shot])]));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'provider_capability_missing' });
    expect(calls).toHaveLength(0);
  });
});

describe('pipeline mode', () => {
  const modules: ModuleDefinition[] = [{
    id: 'mail', name: 'Mail', description: 'Mails senden.', tools: ['mail_send'],
    classification: { hint: 'Mails senden', examples: ['schreib eine mail'] },
  }];

  it('the classifier model sees pseudonyms only and runs behind the boundary', async () => {
    const { tools } = registry();
    const { model, calls } = echoModel();
    const classifierCalls: LanguageModelV3CallOptions[] = [];
    const classifierModel = new MockLanguageModelV3({
      doGenerate: async (options) => {
        classifierCalls.push(options);
        return {
          content: [{ type: 'text', text: JSON.stringify({ moduleId: 'mail', confidence: 0.99 }) }],
          finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
        } as never;
      },
    });
    const pipeline = createLocalAiPipeline({ modules, classifier: { modules, model: classifierModel }, generateText: generateText as never });
    const handler = createAiChatHandler({ tools, model, pipeline, systemPrompt: SYSTEM, privacy: privacyConfig() });
    const history = [
      user(`Kennst du ${CANARY.colleague}?`, 'u0'),
      { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: `Ja, ${CANARY.colleague} (${CANARY.colleagueEmail}).` }] },
    ];
    const response = await handler(post([...history, user(`Schreib eine Mail an ${CANARY.colleagueEmail} wegen ${CANARY.name}`)]));
    expect(response.status).toBe(200);
    await streamChunks(response);
    expect(classifierCalls).toHaveLength(1);
    expect(JSON.stringify(classifierCalls)).not.toMatch(CANARY_PATTERN);
    expect(JSON.stringify(calls)).not.toMatch(CANARY_PATTERN);
  });
});

describe('custom stream handler', () => {
  it('receives the wrapped model and the privacy context', async () => {
    const { tools } = registry();
    const { model } = echoModel();
    let seen: { wrapped: boolean; privacy: boolean } | undefined;
    const handler = createAiChatHandler({
      tools, model, systemPrompt: SYSTEM, privacy: privacyConfig(),
      streamHandler: async (ctx) => {
        const { isPrivacyWrappedModel } = await import('../../../pii-shield/model-boundary.js');
        seen = { wrapped: isPrivacyWrappedModel(ctx.model), privacy: Boolean(ctx.privacy) };
        return new Response('ok');
      },
    });
    await handler(post([user('Hallo')]));
    expect(seen).toEqual({ wrapped: true, privacy: true });
  });
});

describe('PrivacyError', () => {
  it('is content-free by construction', () => {
    expect(new PrivacyError('privacy_output_leak').message).not.toMatch(CANARY_PATTERN);
  });
});
