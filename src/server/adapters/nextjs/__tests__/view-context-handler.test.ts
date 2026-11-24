import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
import { UI_ACTION_HANDOFF_MESSAGE } from '../../../../browser/ui-action-handoff.js';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import { uiActionToolToTool } from '../../../core/index.js';
import { defineTool, type PiiDetector, type PipelineResult, type ToolRegistry } from '../../../../types.js';
import { createPiiShield, createRegexPiiDetector } from '../../../pii-shield/index.js';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import { VIEW_CONTEXT_HEADER } from '../view-context-block.js';
import { canonicalViewContextLabel } from '../../../../contracts/view-context.js';
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
      streamHandler: async (context) => {
        seen.push({ keys: Object.keys(context), messages: context.messages, systemPrompt: context.systemPrompt, earlier: context.earlierMessages });
        return new Response('ok');
      },
    } as AiChatHandlerFullConfig);
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage], ...field(orderView) }),
    }));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/view-context|viewContext|Order 1/);
  });

  it('gives a pseudonym in the block the same as in the user message, which the shield restores', async () => {
    const shield = createPiiShield({ locale: 'en', detector: createRegexPiiDetector({ categories: ['email'] }) });
    const messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write to max@firma.de about this.' }] }];
    const view = [{ entity: { type: 'order', id: 'ord-1' }, label: 'Max <max@firma.de>' }];
    const { prompt } = await promptOf({ piiShield: shield }, field(view), { mode, messages });
    const userText = JSON.stringify(prompt!.at(-2));
    const lines = ((prompt!.at(-1)!.content as Array<{ text: string }>)[0]!.text).split('\n');
    expect(lines).toHaveLength(4);
    const entry = JSON.parse(lines[2]!) as { label: string };
    expect(entry.label).not.toContain('max@firma.de');
    const pseudonym = entry.label.replace(/^Max </, '').replace(/>$/, '');
    expect(entry.label).toBe(`Max <${pseudonym}>`);
    expect(userText).toContain(pseudonym);
    expect(userText).not.toContain('max@firma.de');
    expect(shield.inbound(`Sent to ${entry.label}.`, 'ai-u1')).toBe('Sent to Max <max@firma.de>.');
  });

  it('runs the request without a block when the PII shield fails on it', async () => {
    const shield = createPiiShield({ locale: 'en', detector: { detect: () => [] } });
    shield.anonymizeResult = async () => { throw new Error('detector down'); };
    const without = await promptOf({ piiShield: shield }, {}, { mode });
    const { status, prompt } = await promptOf({ piiShield: shield }, field(orderView), { mode });
    expect(status).toBe(200);
    expect(JSON.stringify(prompt)).toBe(JSON.stringify(without.prompt));
  });

  it('sends no block with a direct command (no model input carries it)', async () => {
    const command = formatChatCommandMessage({ commandId: 'orders.get', tool: 'orders.get', args: { orderId: 'ord-1' }, label: '/Open order' });
    const model = textModel();
    const handler = createAiChatHandler({
      tools: registry, systemPrompt: 'Assistant', model,
      ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
    } as AiChatHandlerFullConfig);
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: command }] }], ...field(orderView) }),
    }));
    const wire = await response.text();
    expect(response.status).toBe(200);
    expect(wire).not.toContain('view-context');
    for (const call of model.doStreamCalls) expect(JSON.stringify(call.prompt)).not.toContain('view-context');
  });
});

describe('requests that do not reach the model normally', () => {
  it('sends no block when the pipeline guardrails block the request', async () => {
    const blocked = { ...pipelineResult, blocked: true };
    const without = await promptOf({ pipeline: { process: async () => blocked } }, {}, { mode: 'pipeline' });
    const { status, prompt } = await promptOf({ pipeline: { process: async () => blocked } }, field(orderView), { mode: 'pipeline' });
    expect(status).toBe(200);
    expect(prompt).toBeDefined();
    expect(JSON.stringify(prompt)).toBe(JSON.stringify(without.prompt));
  });

  it('names types of every offered tool, also when the intent router scopes them away (legacy)', async () => {
    const { prompt } = await promptOf({ intentRouter: async () => ({ toolNames: ['ui_navigate'] }) }, field(orderView));
    expect(blockOf(prompt)).toBe(true);
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

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats viewContext: %s as not set (on, defaults)', async (_name, viewContext) => {
    const model = textModel();
    const handler = createAiChatHandler({ tools: registry, systemPrompt: 'Assistant', model, viewContext } as never);
    await (await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage], ...field(orderView) }),
    }))).text();
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('<view-context>');
  });

  it.each([['0', 0], ['an empty string', ''], ['a number', 3], ['NaN', Number.NaN]])('still throws at creation for %s', (_name, viewContext) => {
    expect(() => createAiChatHandler({ tools: registry, model: textModel(), viewContext } as never)).toThrow(/viewContext/);
  });

  it.each(['changes', 'all'])('throws at creation for history %s (needs view contexts bound to messages, a later release)', (history) => {
    expect(() => createAiChatHandler({ tools: registry, model: textModel(), viewContext: { history } } as never)).toThrow(/viewContext.*history/);
  });
});

describe.each<Mode>(['legacy', 'pipeline'])('view context labels and the PII shield (%s)', (mode) => {
  /** The shield of this package (regex detector), counting its `anonymizeResult` calls. */
  function countingShield() {
    const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
    const calls: unknown[] = [];
    const anonymizeResult = shield.anonymizeResult;
    shield.anonymizeResult = async (value, sessionId) => { calls.push(value); return anonymizeResult(value, sessionId); };
    return { shield, calls };
  }

  it('shields a label before it is cut: no fragment of an address at the cut reaches the model, same pseudonym as in the message', async () => {
    const address = 'max.mustermann@firma-beispiel.de';
    for (const offset of [50, 55, 58, 60, 62, 65]) {
      const label = `${'a'.repeat(offset - 1)} ${address}`;
      const { shield, calls } = countingShield();
      const messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: `Schreib an <${address}> bitte.` }] }];
      const { status, prompt } = await promptOf({ piiShield: shield }, field([{ entity: { type: 'order', id: 'ord-1' }, label }]), { mode, messages });
      expect(status).toBe(200);
      const all = JSON.stringify(prompt);
      for (let start = 0; start + 6 <= address.length; start += 1) {
        expect(all.includes(address.slice(start, start + 6)), `${offset}: ${address.slice(start, start + 6)}`).toBe(false);
      }
      const userText = JSON.stringify(prompt!.at(-2));
      const pseudonym = /<([^<>]+)>/.exec(userText)![1]!;
      const entry = JSON.parse(((prompt!.at(-1)!.content as Array<{ text: string }>)[0]!.text).split('\n')[2]!) as { label: string };
      expect([...entry.label].length).toBeLessThanOrEqual(60);
      expect(entry.label).toBe(canonicalViewContextLabel(`${'a'.repeat(offset - 1)} ${pseudonym}`));
      // Two calls for the block: the labels, then the id.
      expect(calls).toHaveLength(2);
    }
  });

  it('calls the shield once for entries without a label, as before', async () => {
    const { shield, calls } = countingShield();
    const { prompt } = await promptOf({ piiShield: shield }, field([{ entity: { type: 'order', id: 'ord-1' } }]), { mode });
    expect(blockOf(prompt)).toBe(true);
    expect(calls).toEqual([[{ id: 'ord-1' }]]);
  });

  const continuationHistory = [userMessage, {
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
  const clarificationMessages = [
    userMessage,
    {
      id: 'a1', role: 'assistant',
      parts: [{ type: 'tool-ask_clarification', toolCallId: 'call-1', state: 'output-available', input: { question: 'Which order?', target: 'object' }, output: { success: true } }],
    },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: formatClarificationAnswer({ toolCallId: 'call-1', answer: 'The first' }) }] },
  ];
  const labelled = [{ entity: { type: 'order', id: 'ord-1' }, label: 'Kontakt max@firma.de' }];

  it.each<[string, Partial<AiChatHandlerFullConfig>, Record<string, unknown>, unknown[] | undefined]>([
    ['viewContext: false', { viewContext: false }, field(labelled), undefined],
    ['no field', {}, {}, undefined],
    ['another version', {}, { glirastesViewContext: { version: 2, current: labelled } }, undefined],
    ['current not a list', {}, field({ entity: { type: 'order', id: 'ord-1' } }), undefined],
    ['invalid entries only', {}, field([{ entity: { type: 'order', id: '' }, label: 'max@firma.de' }, 7, null]), undefined],
    ['an undeclared type only', {}, field([{ entity: { type: 'invoice', id: 'inv-1' }, label: 'max@firma.de' }]), undefined],
    ['no declared type', { tools: { ui_navigate: navigate } }, field(labelled), undefined],
    ['a continuation', { }, { glirastesUiOutcomes: 1, ...field(labelled) }, continuationHistory],
    ['the answer to a clarification', { clarification: {} }, field(labelled), clarificationMessages],
  ])('calls the shield for no view context with %s', async (_name, config, body, messages) => {
    const { shield, calls } = countingShield();
    const { status, prompt } = await promptOf({ ...config, piiShield: shield }, body, { mode, ...(messages ? { messages } : {}) });
    expect(status).toBe(200);
    expect(blockOf(prompt)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('calls the shield for no view context with a custom stream handler', async () => {
    const { shield, calls } = countingShield();
    const handler = createAiChatHandler({
      tools: registry, systemPrompt: 'Assistant', model: textModel(), piiShield: shield,
      ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
      streamHandler: async () => new Response('ok'),
    } as AiChatHandlerFullConfig);
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage], ...field(labelled) }),
    }));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('calls the shield for a direct command as often as without the field', async () => {
    const command = formatChatCommandMessage({ commandId: 'orders.get', tool: 'orders.get', args: { orderId: 'ord-1' }, label: '/Open order' });
    const run = async (body: Record<string, unknown>) => {
      const { shield, calls } = countingShield();
      const handler = createAiChatHandler({
        tools: registry, systemPrompt: 'Assistant', model: textModel(), piiShield: shield,
        ...(mode === 'pipeline' ? { pipeline: { process: async () => pipelineResult } } : {}),
      } as AiChatHandlerFullConfig);
      const response = await handler(new Request('https://app.example/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: command }] }], ...body }),
      }));
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(wire).not.toContain('view-context');
      return calls;
    };
    expect(await run(field(labelled))).toEqual(await run({}));
  });

  it('calls the shield for no view context when the pipeline guardrails block the request', async () => {
    const { shield, calls } = countingShield();
    const blocked = { ...pipelineResult, blocked: true };
    const { status, prompt } = await promptOf({ piiShield: shield, pipeline: { process: async () => blocked } }, field(labelled), { mode: 'pipeline' });
    expect(status).toBe(200);
    expect(blockOf(prompt)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
