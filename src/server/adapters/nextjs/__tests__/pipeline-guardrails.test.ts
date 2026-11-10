import { describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

function request(text: string) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
  });
}

const result: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], sanitizedInput: 'x',
  intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
};

describe('the guardrails hook with a pipeline', () => {
  it('refuses a request with 400 before the pipeline or the model runs', async () => {
    const process = vi.fn(async () => result);
    const streamHandler = vi.fn(async () => new Response('ok'));
    const handler = createAiChatHandler({
      tools: {}, model: {}, systemPrompt: 'Assistant',
      pipeline: { process },
      guardrails: () => ({ ok: false, reason: 'not_allowed' }),
      streamHandler,
    });

    const response = await handler(request('blocked'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'not_allowed' });
    expect(process).not.toHaveBeenCalled();
    expect(streamHandler).not.toHaveBeenCalled();
  });

  it('hands the sanitized messages to the pipeline and the model', async () => {
    const process = vi.fn(async (_input: string) => result);
    let sent: unknown[] = [];
    const clean = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'clean text' }] }];
    const handler = createAiChatHandler({
      tools: {}, model: {}, systemPrompt: 'Assistant',
      pipeline: { process },
      guardrails: () => ({ ok: true, sanitizedMessages: clean }),
      streamHandler: async (context) => {
        sent = context.messages;
        return new Response('ok');
      },
    });

    expect((await handler(request('dirty text'))).status).toBe(200);
    expect(process.mock.calls[0]![0]).toBe('clean text');
    expect(sent).toEqual(clean);
  });
});
