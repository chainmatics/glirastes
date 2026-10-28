import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createJobModel, ModelAccessError, selectJobModel, stepCostUsd, withJobRouting } from '../openrouter.js';

const ROUTING = {
  provider: { data_collection: 'deny', zdr: true, require_parameters: true },
  usage: { include: true },
};
const JOB_KEY = 'sk-or-v1-job-secret-never-logged-0000';

function completion(cost: number) {
  return new Response(JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion',
    created: 1_791_000_000,
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Fertig.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('managed job model access', () => {
  it('sends every completion through OpenRouter with the routing rules and reads its cost', async () => {
    const fetchImpl = vi.fn(async () => completion(0.0042));
    const model = createJobModel({
      createOpenAI: createOpenAI as never,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: JOB_KEY,
      model: 'anthropic/claude-sonnet-5.5',
      routing: ROUTING,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await generateText({ model, prompt: 'Beschreibe die Tools.' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', ...ROUTING });
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${JOB_KEY}`);
    expect([result.response.modelId, stepCostUsd(result.steps[0]!)]).toEqual(['anthropic/claude-sonnet-5.5', 0.0042]);
  });

  it('leaves requests without a JSON body untouched', async () => {
    const base = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const routed = withJobRouting(ROUTING, base as unknown as typeof fetch);

    await routed('https://openrouter.ai/api/v1/models', { method: 'GET' });
    await routed('https://openrouter.ai/api/v1/x', { method: 'POST', body: 'not json' });

    expect(base.mock.calls.map(([, init]) => init?.body)).toEqual([undefined, 'not json']);
    expect(stepCostUsd({ response: { body: { usage: {} } } })).toBeUndefined();
    expect(stepCostUsd({ response: { body: { usage: { cost: -1 } } } })).toBeUndefined();
  });

  it('starts with the pinned model, falls back once, and never guesses another one', async () => {
    const listing = (models: Array<{ id: string; supported_parameters: string[] }>) =>
      vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ data: models })));
    const select = (fetchImpl: ReturnType<typeof vi.fn>) => selectJobModel({
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: JOB_KEY,
      model: 'anthropic/claude-sonnet-5.5',
      fallbackModel: 'openai/gpt-6.1-sol',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const full = ['tools', 'structured_outputs', 'temperature'];

    const pinned = listing([{ id: 'anthropic/claude-sonnet-5.5', supported_parameters: full }]);
    await expect(select(pinned)).resolves.toEqual({ model: 'anthropic/claude-sonnet-5.5', fallbackUsed: false });
    expect(pinned.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models');
    await expect(select(listing([
      { id: 'anthropic/claude-sonnet-5.5', supported_parameters: ['tools'] },
      { id: 'openai/gpt-6.1-sol', supported_parameters: ['tools', 'response_format'] },
    ]))).resolves.toEqual({ model: 'openai/gpt-6.1-sol', fallbackUsed: true });
    await expect(select(listing([{ id: 'anthropic/claude-sonnet-5.6', supported_parameters: full }])))
      .rejects.toEqual(new ModelAccessError('model_unsupported'));
    await expect(select(vi.fn(async () => new Response('down', { status: 503 }))))
      .rejects.toEqual(new ModelAccessError('models_unreachable'));
  });
});
