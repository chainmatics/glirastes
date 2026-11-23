import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
import { UI_ACTION_HANDOFF_MESSAGE } from '../../../../browser/ui-action-handoff.js';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import { uiActionToolToTool } from '../../../core/index.js';
import { defineTool, type PiiDetector, type PipelineResult, type ToolRegistry } from '../../../../types.js';
import { createPiiShield } from '../../../pii-shield/index.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import { VIEW_CONTEXT_HEADER } from '../view-context-block.js';
import type { RuntimeMetricEvent } from '../../../../contracts/index.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Answer.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never),
    }),
  });
}

const getOrder = defineTool({
  id: 'orders.get',
  description: 'Read one order.',
  method: 'GET',
  inputSchema: z.object({ orderId: z.string() }),
  outputEntities: [{ type: 'order', id: 'id', name: 'name' }],
  inputEntities: [{ type: 'order', args: 'orderId' }],
  execute: async () => ({ id: 'ord-1', name: 'Order 1' }),
});

const navigate = uiActionToolToTool({
  id: 'ui.navigate',
  toolName: 'ui_navigate',
  description: 'Open a page of the app.',
  inputSchema: createJsonSchemaLike({ type: 'object', properties: { destination: { type: 'string' } } }),
  needsApproval: false,
  action: { kind: 'navigate' },
});

const registry: ToolRegistry = { orders_get: getOrder, ui_navigate: navigate };

const userMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is the status of this?' }] };

const field = (current: unknown) => ({ glirastesViewContext: { version: 1, current } });

const orderView = [{ entity: { type: 'order', id: 'ord-1' }, label: 'Order 1', route: '/orders/ord-1' }];

type Mode = 'legacy' | 'pipeline';

const pipelineResult: PipelineResult = {
  model: { modelId: 'fixture' }, tools: [], sanitizedInput: 'x',
  intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
};

async function promptOf(
  config: Partial<AiChatHandlerFullConfig>,
  body: Record<string, unknown>,
  { messages = [userMessage] as unknown[], mode = 'legacy' as Mode } = {},
): Promise<{ status: number; prompt?: Array<Record<string, unknown>> }> {
  const model = textModel();
  const handler = createAiChatHandler({
    tools: registry,
    systemPrompt: 'Assistant',
    ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
    ...config,
    model,
  } as AiChatHandlerFullConfig);
  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, ...body }),
  }));
  await response.text();
  return { status: response.status, prompt: model.doStreamCalls[0]?.prompt as never };
}

const blockOf = (prompt: Array<Record<string, unknown>> | undefined) =>
  JSON.stringify(prompt).includes('<view-context>');

describe.each<Mode>(['legacy', 'pipeline'])('view context in the chat handler (%s)', (mode) => {
  it('changes nothing for an unchanged app: no field gives the same model input with and without the option', async () => {
    const none = await promptOf({}, {}, { mode });
    for (const viewContext of [undefined, true, false, { maxEntries: 2 }] as const) {
      const other = await promptOf(viewContext === undefined ? {} : { viewContext }, {}, { mode });
      expect(JSON.stringify(other.prompt)).toBe(JSON.stringify(none.prompt));
    }
    expect(blockOf(none.prompt)).toBe(false);
  });

  it('adds the block as its own user message after the newest user message, outside the cache breakpoint', async () => {
    const without = await promptOf({}, {}, { mode });
    const { status, prompt } = await promptOf({}, field(orderView), { mode });
    expect(status).toBe(200);
    // Everything before the block is byte-identical: system prompt, history, cache breakpoints.
    expect(JSON.stringify(prompt!.slice(0, -1))).toBe(JSON.stringify(without.prompt));
    const block = prompt!.at(-1)!;
    expect(block.role).toBe('user');
    expect(block.providerOptions).toBeUndefined();
    expect(block.content).toEqual([{
      type: 'text',
      text: [
        '<view-context>',
        VIEW_CONTEXT_HEADER,
        '{"entity":{"type":"order","id":"ord-1"},"label":"Order 1","route":"/orders/ord-1"}',
        '</view-context>',
      ].join('\n'),
    }]);
    const system = prompt!.find((message) => message.role === 'system');
    expect(JSON.stringify(system)).not.toContain('view-context');
    expect(prompt!.at(-2)!.providerOptions).toBeDefined();
  });

  it('adds it without prompt caching as well', async () => {
    const without = await promptOf({ promptCaching: false }, {}, { mode });
    const { prompt } = await promptOf({ promptCaching: false }, field(orderView), { mode });
    expect(JSON.stringify(prompt!.slice(0, -1))).toBe(JSON.stringify(without.prompt));
    expect(blockOf(prompt)).toBe(true);
  });

  it.each([
    ['viewContext: false', { viewContext: false }],
    ['enabled: false', { viewContext: { enabled: false } }],
    ['types: []', { viewContext: { types: [] } }],
  ])('sends no block with %s', async (_name, config) => {
    const without = await promptOf({}, {}, { mode });
    const { prompt } = await promptOf(config as Partial<AiChatHandlerFullConfig>, field(orderView), { mode });
    expect(JSON.stringify(prompt)).toBe(JSON.stringify(without.prompt));
  });

  it.each([
    ['a string', { glirastesViewContext: 'x' }],
    ['another version', { glirastesViewContext: { version: 2, current: orderView } }],
    ['current not a list', field({ entity: { type: 'order', id: 'ord-1' } })],
    ['invalid entries only', field([{ entity: { type: 'order', id: '' } }, 7, null])],
    ['an undeclared type', field([{ entity: { type: 'invoice', id: 'inv-1' } }])],
    ['facts without a schema only', field([{ selection: { type: 'secret', ids: ['x'] } }])],
  ])('ignores %s: 200 and the model input of a request without it', async (_name, body) => {
    const without = await promptOf({}, {}, { mode });
    const { status, prompt } = await promptOf({}, body, { mode });
    expect(status).toBe(200);
    expect(JSON.stringify(prompt)).toBe(JSON.stringify(without.prompt));
  });

  it('keeps facts only with a schema from the handler option', async () => {
    const view = [{ entity: { type: 'order', id: 'ord-1' }, facts: { status: 'open', secret: 'x' } }];
    const dropped = await promptOf({}, field(view), { mode });
    expect(blockOf(dropped.prompt)).toBe(true);
    expect(JSON.stringify(dropped.prompt)).not.toContain('facts');
    const kept = await promptOf({ viewContext: { facts: { order: z.object({ status: z.enum(['open', 'closed']) }) } } }, field(view), { mode });
    expect(JSON.stringify(kept.prompt)).toContain('\\"facts\\":{\\"status\\":\\"open\\"}');
    expect(JSON.stringify(kept.prompt)).not.toContain('secret');
  });

  it('sends no block on a continuation without a new user message', async () => {
    const history = [userMessage, {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'step-start' }, {
        type: 'tool-ui_navigate',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { destination: '/orders' },
        output: {
          handedOff: true, message: UI_ACTION_HANDOFF_MESSAGE, awaitsOutcome: true, outcome: { v: 1, code: 'ok' },
          uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/orders', destination: '/orders' } },
        },
      }],
    }];
    const { status, prompt } = await promptOf({}, { glirastesUiOutcomes: 1, ...field(orderView) }, { mode, messages: history });
    expect(status).toBe(200);
    expect(prompt).toBeDefined();
    expect(blockOf(prompt)).toBe(false);
  });

  it('sends no block with the answer to a clarification (its question had another view, until messages carry their own)', async () => {
    const messages = [
      userMessage,
      {
        id: 'a1', role: 'assistant',
        parts: [{ type: 'tool-ask_clarification', toolCallId: 'call-1', state: 'output-available', input: { question: 'Which order?', target: 'object' }, output: { success: true } }],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: formatClarificationAnswer({ toolCallId: 'call-1', answer: 'The first' }) }] },
    ];
    const { prompt } = await promptOf({ clarification: {} }, field(orderView), { mode, messages });
    expect(prompt).toBeDefined();
    expect(JSON.stringify(prompt)).toContain('Answer: The first');
    expect(blockOf(prompt)).toBe(false);
  });

  it('sends the block through the PII shield like the history', async () => {
    const detector: PiiDetector = {
      detect: (text: string) => {
        const start = text.indexOf('Jane Roe');
        return start < 0 ? [] : [{ type: 'person', start, end: start + 'Jane Roe'.length, score: 1, text: 'Jane Roe' }];
      },
    };
    const view = [{ entity: { type: 'order', id: 'ord-1' }, label: 'Jane Roe' }];
    const { prompt } = await promptOf({ piiShield: createPiiShield({ locale: 'en', detector }) }, field(view), { mode });
    const text = JSON.stringify(prompt!.at(-1));
    expect(text).toContain('<view-context>');
    expect(text).not.toContain('Jane Roe');
  });

  it('gives a custom stream handler no block and no change', async () => {
    const seen: unknown[] = [];
    const handler = createAiChatHandler({
      tools: registry, systemPrompt: 'Assistant', model: textModel(),
      ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
      streamHandler: async (context) => { seen.push(context.messages); return new Response('ok'); },
    } as AiChatHandlerFullConfig);
    await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage], ...field(orderView) }),
    }));
    expect(JSON.stringify(seen)).not.toContain('view-context');
  });
});

describe('metrics', () => {
  async function eventsOf(config: Partial<AiChatHandlerFullConfig>, body: Record<string, unknown>) {
    const events: RuntimeMetricEvent[] = [];
    const sink: RuntimeMetricsSink = {
      identity: { appId: '019fb900-0000-7000-8000-0000000000a1', environmentId: '019fb900-0000-7000-8000-0000000000e1', buildId: null, instanceId: 'web-1' },
      record: (event) => { events.push(event); },
      flush: async () => undefined,
      close: async () => undefined,
    };
    const handler = createAiChatHandler({ tools: registry, systemPrompt: 'Assistant', model: textModel(), metrics: sink, ...config } as AiChatHandlerFullConfig);
    await (await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage], ...body }),
    }))).text();
    // Times and generated ids differ from run to run; everything else must be the same.
    return JSON.stringify(events, (key, value) => (/(At|Ms|Id)$/.test(key) ? '*' : value));
  }

  it('are the same with and without the field and the option (content-free, nothing added)', async () => {
    const plain = await eventsOf({}, {});
    expect(plain.length).toBeGreaterThan(2);
    expect(await eventsOf({ viewContext: true }, {})).toBe(plain);
    expect(await eventsOf({}, field(orderView))).toBe(plain);
    expect(plain).not.toContain('view');
  });
});

describe('viewContext option of createAiChatHandler', () => {
  it.each([
    ['maxEntries 0', { maxEntries: 0 }],
    ['an unknown key', { history: 'none', extra: 1 }],
    ['a facts schema without safeParse', { facts: { order: {} } }],
    ['a string', 'on'],
  ])('throws at creation for %s', (_name, viewContext) => {
    expect(() => createAiChatHandler({ tools: registry, model: textModel(), viewContext } as never)).toThrow(/viewContext/);
  });

  it.each(['changes', 'all'])('throws at creation for history %s (needs view contexts bound to messages, a later release)', (history) => {
    expect(() => createAiChatHandler({ tools: registry, model: textModel(), viewContext: { history } } as never)).toThrow(/viewContext.*history/);
  });
});
