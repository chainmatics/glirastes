import { createOpenAI } from '@ai-sdk/openai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TechnicalRuntimeEventV2Schema,
  type ExecutionBudget,
  type TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import { defineTool, type PipelineResult } from '../../../../types.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const APP_ID = '019fb900-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '019fb900-0000-7000-8000-0000000000e1';
const LIST_TASKS_ID = agentRevision.toolAllowlist[0]!;
const SECRET_TEXT = 'Geheimprojekt Zebra';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolStep(providerMetadata?: Record<string, Record<string, unknown>>) {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'list_tasks',
      input: JSON.stringify({ query: SECRET_TEXT }),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  ] as never);
}

/** A text step; `rawCostUsd` adds OpenRouter's final raw usage chunk. */
function textStep(rawCostUsd?: number) {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: `Erledigt: ${SECRET_TEXT}.` },
    { type: 'text-end', id: 't1' },
    ...(rawCostUsd === undefined ? [] : [{
      type: 'raw',
      rawValue: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: rawCostUsd } },
    }]),
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  ] as never);
}

/** OpenRouter's chat completions stream, served without any network. */
function openRouterFetch(requests: string[]): typeof globalThis.fetch {
  const chunk = (patch: Record<string, unknown>) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1_791_000_000,
    model: 'anthropic/claude-sonnet-5.5',
    ...patch,
  });
  const body = [
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Erledigt.' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0042 } }),
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  return (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
}

function scriptedModel(steps: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const next = steps[Math.min(call, steps.length - 1)]!;
      call += 1;
      return { stream: next() };
    },
  });
}

function collectingSink(record?: (event: TechnicalRuntimeEventV2) => void) {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: { appId: APP_ID, environmentId: ENVIRONMENT_ID, buildId: 'git:4f2c9e1', instanceId: 'web-1' },
    record: (event) => {
      events.push(event);
      record?.(event);
    },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

function managedRuntime(limits: ExecutionBudget = localLimits) {
  return {
    resolvePrincipal: async () => principal,
    resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
      turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits: limits,
    }),
  };
}

function registry(execute: () => Promise<unknown> = async () => ({ tasks: [{ title: SECRET_TEXT }] })) {
  return {
    list_tasks: defineTool({
      id: LIST_TASKS_ID,
      description: 'List visible tasks.',
      inputSchema: z.object({ query: z.string() }),
      execute,
    }),
  };
}

function request() {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: `Zeige ${SECRET_TEXT}` }],
    }] }),
  });
}

describe('turn metrics in the Next chat handler', () => {
  it('records one content-free event with provider-reported cost, tokens, latency and tool ids', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([
        () => toolStep({ openrouter: { usage: { cost: 0.003 } } }),
        () => textStep(0.0018),
      ]),
      systemPrompt: 'You are the Zebra assistant.',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());
    const wire = await response.text();

    expect(wire).toContain('Erledigt');
    expect(events).toHaveLength(1);
    const event = TechnicalRuntimeEventV2Schema.parse(events[0]);
    expect(event).toMatchObject({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      model: 'mock-model-id',
      status: 'completed',
      errorCode: null,
      inputTokens: 20,
      outputTokens: 10,
      toolCallCount: 1,
      toolErrorCount: 0,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 0 }],
    });
    expect(event.cost.source).toBe('provider-reported');
    expect(event.cost.usd).toBeCloseTo(0.0048, 10);
    expect(event.latency.firstTokenMs).not.toBeNull();
    expect(event.latency.firstTokenMs!).toBeLessThanOrEqual(event.latency.totalMs);
    const serialized = JSON.stringify(event);
    for (const content of ['Zebra', 'Zeige', 'list_tasks', 'assistant', 'query']) {
      expect(serialized).not.toContain(content);
    }
  });

  it('reads OpenRouter usage.cost through the OpenAI-compatible provider of Get It Done', async () => {
    const { sink, events } = collectingSink();
    const requests: string[] = [];
    const openrouter = createOpenAI({
      baseURL: 'https://openrouter.invalid/api/v1',
      apiKey: 'not-a-real-key',
      fetch: openRouterFetch(requests),
    });
    const handler = createAiChatHandler({
      tools: registry(),
      model: openrouter.chat('anthropic/claude-sonnet-5.5'),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const wire = await (await handler(request())).text();

    expect(requests).toEqual(['https://openrouter.invalid/api/v1/chat/completions']);
    expect(wire).toContain('Erledigt.');
    expect(wire).not.toContain('"cost"');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      status: 'completed',
      inputTokens: 100,
      outputTokens: 20,
      cost: { usd: 0.0042, source: 'provider-reported', pricingVersion: null },
    });
  });

  it('feeds a known cost into the runtime budget so the cost limit stops the turn', async () => {
    const { sink, events } = collectingSink();
    const model = scriptedModel([
      () => toolStep({ openrouter: { usage: { cost: 0.003 } } }),
      () => textStep(),
    ]);
    const handler = createAiChatHandler({
      tools: registry(),
      model,
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime({ ...localLimits, maxEstimatedCostUsd: 0.002 }),
      metrics: sink,
    });

    const wire = await (await handler(request())).text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(wire).toContain('Stopped at runtime budget: maxEstimatedCostUsd.');
    expect(events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted' });
  });

  it('estimates from the configured price table when the provider reports no cost', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      modelPricing: {
        version: 'test-2026-10',
        models: { 'mock-model-id': { inputUsdPerMillion: 1_000, outputUsdPerMillion: 2_000 } },
      },
    });

    await (await handler(request())).text();

    expect(events[0]?.cost).toEqual({ usd: 0.02, source: 'price-table', pricingVersion: 'test-2026-10' });
  });

  it('keeps an unreported, unpriced cost unknown', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    await (await handler(request())).text();

    expect(events[0]?.cost).toEqual({ usd: null, source: null, pricingVersion: null });
  });

  it('counts a failed tool call as an error of that tool', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(async () => {
        throw new Error(`database rejected ${SECRET_TEXT}`);
      }),
      model: scriptedModel([() => toolStep(), () => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    await (await handler(request())).text();

    expect(events[0]).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }],
    });
    expect(JSON.stringify(events[0])).not.toContain('database rejected');
  });

  it('records a provider failure as a model error turn', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: new MockLanguageModelV3({
        doStream: async () => {
          throw new Error(`provider leaked ${SECRET_TEXT}`);
        },
      }),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      onError: () => undefined,
    });

    await (await handler(request())).text();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error', errorCode: 'model_error' });
    expect(JSON.stringify(events[0])).not.toContain('provider leaked');
  });

  it('records a pipeline failure before streaming as a pipeline error turn', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
      pipeline: {
        process: async (): Promise<PipelineResult> => {
          throw new Error(`classifier saw ${SECRET_TEXT}`);
        },
      },
      onError: () => undefined,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'error',
      errorCode: 'pipeline_error',
      model: null,
      cost: { usd: null, source: null, pricingVersion: null },
      latency: { firstTokenMs: null },
    });
  });

  it('records a turn without a configured model as a pipeline error', async () => {
    const { sink, events } = collectingSink();
    const handler = createAiChatHandler({
      tools: registry(),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error', errorCode: 'pipeline_error', model: null });
  });

  it('never lets a failing sink block or fail the turn', async () => {
    const { sink } = collectingSink(() => {
      throw new Error('sink down');
    });
    const handler = createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      metrics: sink,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Erledigt');
  });

  it('refuses the legacy Lancer telemetry on the managed-local path', () => {
    const telemetry = { emit: vi.fn(), flush: async () => undefined };
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      managedRuntime: managedRuntime(),
      telemetry,
    })).toThrow(/telemetry/);
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      telemetry,
    })).not.toThrow();
  });

  it('refuses an invalid price table when the handler is created', () => {
    expect(() => createAiChatHandler({
      tools: registry(),
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      modelPricing: { version: 'october prices', models: {} },
    })).toThrow();
  });
});
