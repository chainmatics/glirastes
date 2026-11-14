import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type PiiShield, type ToolRegistry } from '../../../../types.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { validateAttachments } from '../request-guards.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const base64Of = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
function pngDataUrl(size = 64): string {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_HEAD);
  return `data:image/png;base64,${base64Of(bytes)}`;
}
const PDF_DATA_URL = `data:application/pdf;base64,${base64Of(new TextEncoder().encode('%PDF-1.7 hello'))}`;

const filePart = (url: string, mediaType = 'image/png', filename = 'shot.png') =>
  ({ type: 'file', mediaType, url, filename });
const userMessage = (parts: unknown[], id = 'u1') => ({ id, role: 'user', parts });

function setup(extra: Partial<Parameters<typeof createAiChatHandler>[0]> = {}) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Looks fine.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never),
    }),
  });
  const tools: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list', description: 'List.', inputSchema: z.object({}).strict(), needsApproval: false, execute: async () => ({ tasks: [] }),
    }),
  };
  const handler = createAiChatHandler({ tools, model, systemPrompt: 'Assistant', ...extra });
  return { handler, model };
}

function post(messages: unknown[]) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

function modelFileParts(model: MockLanguageModelV3): Array<Record<string, unknown>> {
  const prompt = model.doStreamCalls[0]?.prompt ?? [];
  return prompt.flatMap((message) => (Array.isArray(message.content) ? (message.content as ReadonlyArray<unknown>) : []))
    .filter((part) => (part as { type?: string }).type === 'file') as Array<Record<string, unknown>>;
}

const enabled = { enabled: true } as const;

describe('validateAttachments', () => {
  it('accepts messages without file parts whether or not attachments are enabled', () => {
    expect(validateAttachments([userMessage([{ type: 'text', text: 'hi' }])], undefined)).toBeUndefined();
  });

  it('refuses file parts with 400 while attachments are disabled', async () => {
    const response = validateAttachments([userMessage([filePart(pngDataUrl())])], undefined);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'attachments_disabled' });
  });

  it('accepts allowed data URLs whose bytes match the declared type', () => {
    expect(validateAttachments([userMessage([filePart(pngDataUrl()), filePart(PDF_DATA_URL, 'application/pdf', 'a.pdf')])], enabled)).toBeUndefined();
  });

  it('refuses a media type outside the allow-list with 415', async () => {
    const svg = `data:image/svg+xml;base64,${base64Of(new TextEncoder().encode('<svg/>'))}`;
    const response = validateAttachments([userMessage([filePart(svg, 'image/svg+xml')])], enabled);
    expect(response?.status).toBe(415);
    expect(await response?.json()).toMatchObject({ error: 'unsupported_attachment_type' });
  });

  it('refuses bytes that do not match the declared type', async () => {
    const response = validateAttachments([userMessage([filePart(PDF_DATA_URL, 'image/png')])], enabled);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'invalid_attachment' });
  });

  it('refuses a data URL whose own media type differs from the part', async () => {
    const response = validateAttachments([userMessage([filePart(pngDataUrl().replace('image/png', 'image/gif'))])], enabled);
    expect(response?.status).toBe(400);
  });

  it('refuses a decoded file over maxFileBytes with 413', async () => {
    const response = validateAttachments([userMessage([filePart(pngDataUrl(2_000))])], { enabled: true, maxFileBytes: 1_000 });
    expect(response?.status).toBe(413);
    expect(await response?.json()).toMatchObject({ error: 'attachment_too_large' });
  });

  it('refuses more than maxFiles in one message', async () => {
    const parts = Array.from({ length: 3 }, () => filePart(pngDataUrl()));
    const response = validateAttachments([userMessage(parts)], { enabled: true, maxFiles: 2 });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'too_many_attachments' });
  });

  it('checks every message of the history, not only the last', () => {
    const response = validateAttachments([
      userMessage([filePart(PDF_DATA_URL, 'image/png')], 'u0'),
      userMessage([{ type: 'text', text: 'next' }], 'u1'),
    ], enabled);
    expect(response?.status).toBe(400);
  });

  it('refuses remote URLs unless allowRemoteUrls is set', async () => {
    const remote = [userMessage([filePart('https://cdn.example/a.png')])];
    const response = validateAttachments(remote, enabled);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'remote_attachment_refused' });
    expect(validateAttachments(remote, { enabled: true, allowRemoteUrls: true })).toBeUndefined();
    expect(validateAttachments([userMessage([filePart('file:///etc/passwd')])], { enabled: true, allowRemoteUrls: true })?.status).toBe(400);
  });

  it('refuses a file part without data (an omitted attachment)', () => {
    expect(validateAttachments([userMessage([filePart('')])], enabled)?.status).toBe(400);
  });

  it('honours a custom mediaTypes list', () => {
    const plain = `data:text/plain;base64,${base64Of(new TextEncoder().encode('notes'))}`;
    expect(validateAttachments([userMessage([filePart(plain, 'text/plain', 'n.txt')])], { enabled: true, mediaTypes: ['text/plain'] })).toBeUndefined();
    expect(validateAttachments([userMessage([filePart(pngDataUrl())])], { enabled: true, mediaTypes: ['text/plain'] })?.status).toBe(415);
  });
});

describe('chat handler with attachments', () => {
  it('passes an image part to the model', async () => {
    const { handler, model } = setup({ attachments: enabled });
    const url = pngDataUrl();
    const response = await handler(post([userMessage([{ type: 'text', text: 'What is this?' }, filePart(url)])]));
    expect(response.status).toBe(200);
    await response.text();
    const files = modelFileParts(model);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mediaType: 'image/png' });
    expect(JSON.stringify(files[0]!.data)).toContain(url.slice('data:image/png;base64,'.length, 40));
  });

  it('answers 400 to a file part while attachments are disabled, without a model call', async () => {
    const { handler, model } = setup();
    const response = await handler(post([userMessage([filePart(pngDataUrl())])]));
    expect(response.status).toBe(400);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('answers 413 to an oversized file', async () => {
    const { handler, model } = setup({ attachments: { enabled: true, maxFileBytes: 100 } });
    const response = await handler(post([userMessage([filePart(pngDataUrl(500))])]));
    expect(response.status).toBe(413);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('keeps the 1 MB body limit while attachments are disabled and raises it when enabled', async () => {
    const big = [userMessage([{ type: 'text', text: 'x' }, filePart(pngDataUrl(1_200_000))])];
    expect((await setup().handler(post(big))).status).toBe(413);
    const response = await setup({ attachments: enabled }).handler(post(big));
    expect(response.status).toBe(200);
    await response.text();
  });

  it('lets an explicit maxBodyBytes win', async () => {
    const big = [userMessage([filePart(pngDataUrl(1_200_000))])];
    expect((await setup({ attachments: enabled, maxBodyBytes: 1_000_000 }).handler(post(big))).status).toBe(413);
  });

  it('refuses attachments next to a PII shield unless allowWithPiiShield is set', () => {
    const shield = mockShield();
    expect(() => setup({ attachments: enabled, piiShield: shield })).toThrow(/allowWithPiiShield/);
    expect(() => setup({ attachments: { enabled: true, allowWithPiiShield: true }, piiShield: shield })).not.toThrow();
    expect(() => setup({ attachments: { enabled: false }, piiShield: shield })).not.toThrow();
  });
});

function mockShield(): PiiShield {
  return {
    outbound: vi.fn(async (text: string) => text.replace('Alice', '[PERSON_1]')),
    inbound: vi.fn((text: string) => text),
    rehydrateArgs: vi.fn((args: Record<string, unknown>) => args),
    rehydrateArgsAsync: vi.fn(async (args: Record<string, unknown>) => args),
    anonymizeResult: vi.fn(async (result: unknown) => result),
    getComplianceSummary: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as PiiShield;
}

describe('attachments stay out of the text paths', () => {
  it('passes file parts through the PII shield byte-identical and never sends them to the detector', async () => {
    const shield = mockShield();
    const { handler, model } = setup({ attachments: { enabled: true, allowWithPiiShield: true }, piiShield: shield });
    const url = pngDataUrl(4_000);
    const response = await handler(post([userMessage([{ type: 'text', text: 'Alice sent this' }, filePart(url)])]));
    expect(response.status).toBe(200);
    await response.text();

    const payload = url.slice('data:image/png;base64,'.length);
    const files = modelFileParts(model);
    expect(files).toHaveLength(1);
    const data = files[0]!.data;
    const sent = typeof data === 'string' ? data : data instanceof Uint8Array ? base64Of(data) : String(data);
    expect(sent.replace(/^data:image\/png;base64,/, '')).toBe(payload);

    const detectorInputs = vi.mocked(shield.outbound).mock.calls.map(([text]) => String(text));
    expect(detectorInputs.length).toBeGreaterThan(0);
    for (const input of detectorInputs) {
      expect(input).not.toContain('data:');
      expect(input).not.toContain(payload.slice(0, 32));
    }
  });

  it('keeps data URLs out of audit, telemetry and metrics payloads', async () => {
    const audit: unknown[] = [];
    const telemetry: unknown[] = [];
    const metrics: unknown[] = [];
    const sink: RuntimeMetricsSink = {
      identity: { appId: '019fb900-0000-7000-8000-0000000000a1', environmentId: '019fb900-0000-7000-8000-0000000000e1', buildId: 'git:1', instanceId: 'w1' },
      record: (event) => { metrics.push(event); },
      flush: async () => undefined,
      close: async () => undefined,
    };
    const { handler } = setup({
      attachments: enabled,
      onAudit: (event: unknown) => { audit.push(event); },
      telemetry: { emit: (event: unknown) => { telemetry.push(event); }, flush: async () => undefined } as never,
      metrics: sink,
    });
    const response = await handler(post([userMessage([{ type: 'text', text: 'see' }, filePart(pngDataUrl()), filePart(PDF_DATA_URL, 'application/pdf', 'a.pdf')])]));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(audit.length + telemetry.length + metrics.length).toBeGreaterThan(0);
    expect(JSON.stringify({ audit, telemetry, metrics })).not.toContain('data:');
    expect(JSON.stringify({ audit, telemetry, metrics })).not.toContain('base64');
  });
});
