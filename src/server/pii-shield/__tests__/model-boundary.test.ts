import { describe, expect, it, vi } from 'vitest';
import { generateText, jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { resolveAttachmentPolicy } from '../attachment-policy.js';
import { createPrivacyBoundary, isPrivacyWrappedModel } from '../model-boundary.js';
import { wrapToolsForPrivacy } from '../tool-boundary.js';
import {
  CANARY,
  CANARY_PATTERN,
  captureFetch,
  captureModel,
  memoryShield,
  providerAdapters,
  testScope,
} from './privacy-fixtures.js';
import { createOpenAI } from '@ai-sdk/openai';

async function boundaryFor(options: Parameters<typeof createPrivacyBoundary>[0] extends infer O ? Partial<O> : never = {}) {
  const session = await memoryShield().open(testScope());
  await session.registerIdentities([{ id: CANARY.userId, name: CANARY.name, email: CANARY.email }]);
  return createPrivacyBoundary({ session, ...options });
}

function serializedCalls(calls: unknown[]): string {
  return JSON.stringify(calls);
}

const SYSTEM = `Du hilfst ${CANARY.name} (Nutzer-ID ${CANARY.userId}, ${CANARY.email}).`;

describe('full model context', () => {
  it('protects a string system prompt, history, assistant turns and the new user message', async () => {
    const boundary = await boundaryFor();
    await boundary.session.registerIdentities([{ id: CANARY.uuid, name: CANARY.colleague }]);
    const { model, calls } = captureModel([{ text: 'Gern.' }]);
    const messages: ModelMessage[] = [
      { role: 'user', content: `Ich bin ${CANARY.name}` },
      { role: 'assistant', content: `Hallo ${CANARY.firstName}!` },
      { role: 'user', content: [{ type: 'text', text: `Schreib ${CANARY.colleagueEmail} wegen ${CANARY.uuid}` }] },
    ];
    await generateText({ model: boundary.wrapModel(model), system: SYSTEM, messages });
    expect(calls).toHaveLength(1);
    expect(serializedCalls(calls)).not.toMatch(CANARY_PATTERN);
    expect(serializedCalls(calls)).not.toMatch(/\bAnna\b/);
  });

  it('protects the cached system-message form (promptCaching) and keeps allowed cache markers', async () => {
    const boundary = await boundaryFor();
    const { model, calls } = captureModel();
    await generateText({
      model: boundary.wrapModel(model),
      system: [{ role: 'system', content: SYSTEM, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }],
      prompt: 'Hallo',
    });
    const system = calls[0]!.prompt[0]!;
    expect(system.role).toBe('system');
    expect(JSON.stringify(system)).not.toMatch(CANARY_PATTERN);
    expect(system.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  it('protects every step of a streamed multi-step tool turn, and the tool gets the original', async () => {
    const boundary = await boundaryFor();
    const session = boundary.session;
    await session.registerIdentities([{ name: CANARY.colleague, email: CANARY.colleagueEmail, id: CANARY.colleagueId }]);
    const fakeColleagueEmail = await session.pseudonymizeText(CANARY.colleagueEmail);
    const { model, calls } = captureModel([
      { toolCall: { name: 'lookupUser', input: { email: fakeColleagueEmail } } },
      { text: 'Fertig.' },
    ]);
    const execute = vi.fn(async ({ email }: { email: string }) => ({
      userId: CANARY.colleagueId,
      name: CANARY.colleague,
      email,
      manager: { userId: 'u-9001', name: 'Clara Geheim', email: 'clara.geheim@example.invalid' },
    }));
    const tools = wrapToolsForPrivacy({
      lookupUser: tool({
        description: `Sucht Kollegen von ${CANARY.name}`,
        inputSchema: z.object({ email: z.string() }),
        execute,
      }),
    }, boundary);
    const result = streamText({
      model: boundary.wrapModel(model),
      system: SYSTEM,
      prompt: `Wer ist ${CANARY.colleagueEmail}?`,
      tools,
      stopWhen: stepCountIs(3),
    });
    await result.consumeStream();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ email: CANARY.colleagueEmail });
    expect(calls).toHaveLength(2);
    const wire = serializedCalls(calls);
    expect(wire).not.toMatch(CANARY_PATTERN);
    // A person newly seen in a tool result is protected on the next step too.
    expect(wire).not.toMatch(/Clara Geheim|clara\.geheim|u-9001/);
  });

  it('a thrown tool error reaches the model only as a content-free code', async () => {
    const boundary = await boundaryFor();
    const { model, calls } = captureModel([{ toolCall: { name: 'fail', input: {} } }, { text: 'Ok.' }]);
    const onToolError = vi.fn();
    const tools = wrapToolsForPrivacy({
      fail: tool({ inputSchema: z.object({}), execute: async (): Promise<unknown> => { throw new Error(`backend rejected ${CANARY.email}`); } }),
    }, boundary, { onToolError });
    await generateText({ model: boundary.wrapModel(model), prompt: 'x', tools, stopWhen: stepCountIs(3) });
    const wire = serializedCalls(calls);
    expect(wire).not.toMatch(CANARY_PATTERN);
    expect(wire).toContain('tool_failed');
    expect(JSON.stringify(onToolError.mock.calls)).not.toMatch(CANARY_PATTERN);
  });
});

describe('output leak check', () => {
  it('stops a generated text that contains a protected original', async () => {
    const boundary = await boundaryFor();
    const { model } = captureModel([{ text: `Die Mail ist ${CANARY.email}` }]);
    await expect(generateText({ model: boundary.wrapModel(model), prompt: 'x', maxRetries: 0 })).rejects.toMatchObject({ code: 'privacy_output_leak' });
  });

  it('stops a streamed text part that contains a protected original', async () => {
    const boundary = await boundaryFor();
    const { model } = captureModel([{ text: `Die Mail ist ${CANARY.email}` }]);
    const errors: unknown[] = [];
    const result = streamText({ model: boundary.wrapModel(model), prompt: 'x', onError: ({ error }) => { errors.push(error); } });
    let text = '';
    for await (const part of result.fullStream) if (part.type === 'text-delta') text += part.text;
    expect(errors).toEqual([expect.objectContaining({ code: 'privacy_output_leak' })]);
    // Deltas are held until the part passed the check: no fragment escapes.
    expect(text).toBe('');
  });
});

describe('wrapping', () => {
  it('is idempotent for the same boundary and refuses a model of another boundary', async () => {
    const a = await boundaryFor();
    const b = await boundaryFor();
    const { model } = captureModel();
    const wrapped = a.wrapModel(model);
    expect(a.wrapModel(wrapped)).toBe(wrapped);
    expect(isPrivacyWrappedModel(wrapped)).toBe(true);
    expect(isPrivacyWrappedModel(model)).toBe(false);
    expect(() => b.wrapModel(wrapped)).toThrow(expect.objectContaining({ code: 'privacy_scope_invalid' }));
  });

  it('refuses model ids as strings and non-v3 models', async () => {
    const boundary = await boundaryFor();
    expect(() => boundary.wrapModel('openai/gpt-4o-mini')).toThrow(expect.objectContaining({ code: 'privacy_unsupported_content' }));
    expect(() => boundary.wrapModel({ specificationVersion: 'v2' })).toThrow(expect.objectContaining({ code: 'privacy_unsupported_content' }));
  });
});

describe('tool schemas', () => {
  it('pseudonymizes descriptions and defaults and withholds a tool whose enum names a person', async () => {
    const boundary = await boundaryFor();
    const blocked = vi.fn();
    const withBlocked = createPrivacyBoundary({ session: boundary.session, onBlocked: blocked });
    const { model, calls } = captureModel();
    await generateText({
      model: withBlocked.wrapModel(model),
      prompt: 'x',
      tools: {
        assign: tool({
          description: `Weist Aufgaben an ${CANARY.name} zu`,
          inputSchema: jsonSchema<{ who?: string }>({ type: 'object', properties: { who: { type: 'string', default: CANARY.email, description: `z. B. ${CANARY.name}` } } }),
        }),
        pick: tool({
          description: 'Auswahl',
          inputSchema: jsonSchema<{ who: string }>({ type: 'object', properties: { who: { type: 'string', enum: [CANARY.email, 'niemand'] } } }),
        }),
      },
    });
    const sent = calls[0]!.tools!;
    expect(sent.map((t) => t.name)).toEqual(['assign']);
    expect(JSON.stringify(sent)).not.toMatch(CANARY_PATTERN);
    expect(blocked).toHaveBeenCalledWith('privacy_tool_schema_blocked');
  });

  it('a forced tool choice of a withheld tool stops the call', async () => {
    const boundary = await boundaryFor();
    const { model, calls } = captureModel();
    await expect(generateText({
      model: boundary.wrapModel(model),
      prompt: 'x',
      maxRetries: 0,
      toolChoice: { type: 'tool', toolName: 'pick' },
      tools: { pick: tool({ inputSchema: jsonSchema<{ w: string }>({ type: 'object', properties: { w: { const: CANARY.email } } }) }) },
    })).rejects.toMatchObject({ code: 'privacy_tool_schema_blocked' });
    expect(calls).toHaveLength(0);
  });
});

describe('attachments in the model context', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('withholds a screenshot under the default (blocked) policy', async () => {
    const boundary = await boundaryFor();
    const { model, calls } = captureModel();
    await generateText({
      model: boundary.wrapModel(model),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Siehe Bild' }, { type: 'image', image: png, mediaType: 'image/png' }] }],
    });
    const content = (calls[0]!.prompt[0] as { content: Array<{ type: string }> }).content;
    expect(content.map((p) => p.type)).toEqual(['text', 'text']);
  });

  it('passes an inline screenshot unchanged only with allow-original and a vision-capable model', async () => {
    const attachments = resolveAttachmentPolicy({ app: 'allow-original', tenant: 'allow-original' });
    const boundary = await boundaryFor({ attachments, capabilities: { images: true } });
    const { model, calls } = captureModel();
    await generateText({
      model: boundary.wrapModel(model),
      messages: [{ role: 'user', content: [{ type: 'image', image: png, mediaType: 'image/png' }] }],
    });
    const content = (calls[0]!.prompt[0] as { content: Array<{ type: string }> }).content;
    expect(content.map((p) => p.type)).toEqual(['file']);
  });

  it('withholds a remote image URL even with allow-original', async () => {
    const attachments = resolveAttachmentPolicy({ app: 'allow-original', tenant: 'allow-original' });
    const boundary = await boundaryFor({ attachments, capabilities: { images: true } });
    const { model, calls } = captureModel();
    await generateText({
      model: boundary.wrapModel(model),
      messages: [{ role: 'user', content: [{ type: 'image', image: new URL('https://example.invalid/a.png'), mediaType: 'image/png' }] }],
    }).catch(() => undefined);
    expect(JSON.stringify(calls)).not.toContain('example.invalid/a.png');
  });
});

describe('provider transport (captured HTTP body)', () => {
  for (const kind of ['openrouter', 'anthropic'] as const) {
    it(`${kind}: generate and stream bodies carry no original, including a retried request`, async () => {
      const adapters = providerAdapters();
      const { model, requests } = adapters[kind];
      const boundary = await boundaryFor();
      const wrapped = boundary.wrapModel(model);
      await generateText({ model: wrapped, system: SYSTEM, prompt: `Mail an ${CANARY.email}` });
      const stream = streamText({ model: wrapped, system: SYSTEM, prompt: `Mail an ${CANARY.email}` });
      await stream.consumeStream();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.body).not.toMatch(CANARY_PATTERN);
        expect(request.body.length).toBeGreaterThan(20);
      }
      expect(JSON.parse(requests[1]!.body).stream).toBe(true);
    });
  }

  it('a retry after a provider 503 sends the same protected body', async () => {
    const capture = captureFetch('openai-chat', { failFirst: true });
    const model = createOpenAI({ baseURL: 'https://openrouter.example.invalid/api/v1', apiKey: 'k', fetch: capture.fetch }).chat('m');
    const boundary = await boundaryFor();
    await generateText({ model: boundary.wrapModel(model), system: SYSTEM, prompt: CANARY.email, maxRetries: 1 });
    expect(capture.requests).toHaveLength(2);
    expect(capture.requests[0]!.body).toBe(capture.requests[1]!.body);
    for (const r of capture.requests) expect(r.body).not.toMatch(CANARY_PATTERN);
  });
});
