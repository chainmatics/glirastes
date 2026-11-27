import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatViewSpec, Principal } from '../../../../contracts/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createPiiShield } from '../../../pii-shield/index.js';
import { defineTool, type PiiDetector, type PiiEntity, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler, type AiChatHandlerFullConfig, type StreamHandlerContext } from '../create-ai-chat-handler.js';
import {
  agentRevision, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal,
} from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const invoiceRows = (count: number, body = '') => Array.from({ length: count }, (_, index) => ({
  id: `inv_${index}`,
  customer: `Customer ${index}`,
  total: (index + 1) * 10,
  status: index % 2 === 0 ? 'open' : 'paid',
  ...(body ? { body: `${body}${index}` } : {}),
}));

function invoiceTools(rows: () => unknown[] = () => invoiceRows(5), name = 'invoices_list') {
  const list = vi.fn(async (_input: unknown) => ({ success: true, data: rows() }));
  const registry: ToolRegistry = {
    [name]: defineTool({ id: LIST_TASKS_ID, description: 'List invoices.', inputSchema: z.object({}).strict(), execute: list }),
  };
  return { list, registry };
}

const ref = (callId: string, path: string) => ({ $ref: callId, path });

function tableSpec(callId: string, cellField = 'customer'): ChatViewSpec {
  return {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Invoices' }, children: ['table'] },
      table: {
        type: 'Table',
        props: { rows: ref(callId, 'data[]'), columns: [{ header: 'Customer', cell: 'cell' }] },
      },
      cell: { type: 'StatusBadge', props: { label: { $item: cellField }, tone: 'neutral' } },
    },
  };
}

const cardSpec: ChatViewSpec = { root: 'card', elements: { card: { type: 'Card', props: { title: 'Hello' } } } };

const userMessage = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

/** An earlier turn: the user asked, `invoices_list` ran as `call-old`, the assistant answered. */
function earlierTurn(extraParts: unknown[] = []) {
  return [
    userMessage('u0', 'Show invoices'),
    {
      id: 'a0',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-invoices_list', toolCallId: 'call-old', state: 'output-available',
          input: {}, output: { success: true, data: invoiceRows(5) },
        },
        ...extraParts,
        { type: 'text', text: 'Here they are.' },
      ],
    },
  ];
}

const post = (messages: unknown[], extra: Record<string, unknown> = {}) => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages, ...extra }),
});

type Call = (name: string, input: unknown, toolCallId?: string) => Promise<Record<string, unknown>>;

/** A handler whose custom stream handler runs `script` with the request's tools, as the AI SDK calls them. */
function harness(config: Partial<AiChatHandlerFullConfig>) {
  let script: (call: Call, ctx: StreamHandlerContext) => Promise<void> = async () => undefined;
  let failure: unknown;
  let callIds = 0;
  const handler = createAiChatHandler({
    model: {},
    systemPrompt: 'Assistant',
    ...config,
    streamHandler: async (ctx) => {
      const call: Call = async (name, input, toolCallId) => {
        const tool = ctx.tools[name] as {
          needsApproval?: (input: unknown, options: unknown) => unknown;
          execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
        };
        const options = { toolCallId: toolCallId ?? `call-${callIds += 1}`, messages: [] };
        if (typeof tool.needsApproval === 'function') await tool.needsApproval(input, options);
        return tool.execute(input, options);
      };
      try {
        await script(call, ctx);
      } catch (error) {
        failure = error;
      }
      return new Response('ok');
    },
  } as AiChatHandlerFullConfig);
  return {
    async run(next: typeof script, messages: unknown[] = [userMessage('u1', 'Show invoices')], extra: Record<string, unknown> = {}) {
      script = next;
      failure = undefined;
      const response = await handler(post(messages, extra));
      await response.text();
      if (failure) throw failure;
      return response;
    },
  };
}

type Chunk = Record<string, unknown>;

/** A model that plays `steps` (tool calls or a final text), one per model call. */
function scriptedModel(steps: Array<Array<{ toolCallId: string; toolName: string; input: unknown }> | string>) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const current = steps[Math.min(step, steps.length - 1)]!;
      step += 1;
      const chunks: Chunk[] = typeof current === 'string'
        ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: current }, { type: 'text-end', id: 't' }]
        : current.map((call) => ({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.stringify(call.input) }));
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...chunks,
          { type: 'finish', finishReason: { unified: typeof current === 'string' ? 'stop' : 'tool-calls', raw: undefined }, usage },
        ] as never),
      };
    },
  });
}

/** The UI stream chunks of a response body. */
function chunksOf(wire: string): Chunk[] {
  return wire.split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

/** Ids and times the stream makes up per response, replaced so two runs compare. */
const normalized = (wire: string) => wire
  .replace(/"(messageId|id)":"[^"]*"/g, '"$1":"x"')
  .replace(/"(updatedAt|createdAt)":"[^"]*"/g, '"$1":"t"');

function managed(options: { current?: () => Principal | undefined; revoked?: () => string[] } = {}) {
  const resolvePrincipal = vi.fn(async () => (options.current ? options.current() : principal()));
  return {
    approvalSecret: 'render-view-test-secret-32-chars!!!',
    managedRuntime: {
      resolvePrincipal,
      resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
        turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(), localLimits,
      }),
      loadRevocations: async () => {
        const revoked = options.revoked?.() ?? [];
        return revoked.length > 0
          ? [{
              revocationId: '019fb710-0000-7000-8000-0000000000d1',
              environmentId: manifestRevision.environmentId,
              effectiveAt: new Date(0).toISOString(),
              reasonCode: 'security-disable' as const,
              toolIds: revoked,
              agentRevisionIds: [],
              policyRevisionIds: [],
              signature: agentRevision.signature,
            }]
          : [];
      },
    },
  } satisfies Partial<AiChatHandlerFullConfig>;
}

describe('render_view (chat views)', () => {
  it('off by default: no render_view tool and identical stream', async () => {
    const runs: Array<{ wire: string; calls: unknown }> = [];
    for (const body of [{}, { chatViews: { components: [{ id: 'Card', schemaVersion: 1 }], surface: 'narrow' } }]) {
      const { registry } = invoiceTools();
      const model = scriptedModel([[{ toolCallId: 'call-1', toolName: 'invoices_list', input: {} }], 'Done.']);
      const handler = createAiChatHandler({ tools: registry, model, systemPrompt: 'Assistant' });
      const wire = await (await handler(post([...earlierTurn(), userMessage('u1', 'Again')], body))).text();
      runs.push({ wire: normalized(wire), calls: model.doStreamCalls.map((call) => ({ prompt: call.prompt, tools: call.tools })) });
      for (const call of model.doStreamCalls) {
        expect(call.tools?.map((tool) => tool.name)).not.toContain('render_view');
        expect(JSON.stringify(call.prompt)).not.toContain('render_view');
        expect(JSON.stringify(call.prompt)).not.toContain('call-old ·');
      }
    }
    expect(runs[1]).toEqual(runs[0]);
  });

  it.each([
    ['legacy', false, false],
    ['pipeline', true, false],
    ['legacy managed', false, true],
    ['pipeline managed', true, true],
  ] as const)('renders a view from a current-turn tool result (%s)', async (_label, withPipeline, isManaged) => {
    const name = isManaged ? 'tasks_list' : 'invoices_list';
    const { registry } = invoiceTools(undefined, name);
    const model = scriptedModel([
      [{ toolCallId: 'call-1', toolName: name, input: {} }],
      [{ toolCallId: 'call-2', toolName: 'render_view', input: tableSpec('call-1') }],
      'Done.',
    ]);
    const onError = vi.fn();
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'Assistant', onError, chatViews: {},
      ...(isManaged ? managed() : {}),
      ...(withPipeline
        ? {
            pipeline: {
              // An explicit selection without render_view: it stays like the other always-on built-ins.
              process: async (input: string) => ({
                model: { modelId: 'm' }, tools: [name], toolSelection: 'explicit' as const, sanitizedInput: input,
                intent: { intent: 'x', confidence: 1 }, module: null, followupsEnabled: false,
              }),
            },
          }
        : {}),
    });
    const wire = await (await handler(post([userMessage('u1', 'Show invoices')]))).text();
    expect(onError).not.toHaveBeenCalled();
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toContain('render_view');
    const renderTool = model.doStreamCalls[0]!.tools!.find((tool) => tool.name === 'render_view') as { description?: string };
    expect(renderTool.description).toContain('Table(');
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain('Tool results of this turn');
    const secondStep = model.doStreamCalls[1]!.prompt;
    const systemPrefix = secondStep.slice(0, secondStep.findIndex(message => message.role !== 'system'));
    expect(JSON.stringify(systemPrefix)).toContain('Tool results of this turn');
    const followUpPrompt = JSON.stringify(secondStep);
    expect(followUpPrompt).toContain('Assistant');
    expect(followUpPrompt).toContain(`call-1 · ${name} · data[] (5)`);

    const output = chunksOf(wire).find((chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'call-2')
      ?.output as { shown: boolean; elements: number; view: { v: number; root: string; elements: Record<string, { rows?: unknown[] }> } };
    expect(output).toMatchObject({ shown: true, elements: 3, view: { v: 1, root: 'card' } });
    expect(output.view.elements.table!.rows).toEqual(invoiceRows(5).map((row) => ({ cell: { label: row.customer, tone: 'neutral' } })));

    // The model got only `shown` and `elements` for the render_view call.
    const third = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(third).toContain('"shown":true');
    expect(third).not.toContain('"view"');
    expect(third).toContain('"toolName":"render_view","output":{"type":"json","value":{"shown":true,"elements":3}}');
  });

  it('full result from store when overview was shown', async () => {
    // 20 invoices with a long body: over the 16,000 character limit, so the model sees an overview.
    const { registry } = invoiceTools(() => invoiceRows(20, `${'x'.repeat(900)}-`));
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (call) => {
      const overview = await call('invoices_list', {}, 'call-1') as { _result: { id: string; omitted?: Array<{ path: string }> } };
      expect(overview._result.omitted?.map((entry) => entry.path)).toContain('data[].body');
      const shown = await call('render_view', tableSpec('call-1', 'body'), 'call-2') as {
        view: { elements: Record<string, { rows?: Array<{ cell: { label: string } }>; truncatedRows?: unknown }> };
      };
      const rows = shown.view.elements.table!.rows!;
      expect(rows).toHaveLength(20);
      expect(rows[7]!.cell.label).toBe(`${'x'.repeat(900)}-7`);
    });
  });

  it('earlier-turn reference resolves from request history', async () => {
    const { registry, list } = invoiceTools();
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (call) => {
      const shown = await call('render_view', tableSpec('call-old'));
      expect(shown).toMatchObject({ shown: true, elements: 3 });
      expect((shown.view as { elements: Record<string, { rows?: unknown[] }> }).elements.table!.rows).toHaveLength(5);
      expect(await call('render_view', tableSpec('call-unknown'))).toMatchObject({ success: false });
    }, [...earlierTurn(), userMessage('u1', 'Show them as a table')]);
    expect(list).not.toHaveBeenCalled();
  });

  it('history: view stripped from model input', async () => {
    const { registry } = invoiceTools();
    const model = scriptedModel(['Fine.']);
    const viewPart = {
      type: 'tool-render_view', toolCallId: 'call-view', state: 'output-available',
      input: tableSpec('call-old'),
      output: { shown: true, elements: 3, view: { v: 1, root: 'card', elements: { card: { type: 'Card', schemaVersion: 1, props: { title: 'SECRET-PROJECTION' } } } } },
    };
    const handler = createAiChatHandler({ tools: registry, model, systemPrompt: 'Assistant', chatViews: {} });
    await (await handler(post([...earlierTurn([viewPart]), userMessage('u1', 'Thanks')]))).text();
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).not.toContain('SECRET-PROJECTION');
    // The source memo names what the model can reference: field names and counts only.
    expect(prompt).toContain('call-old · invoices_list · data[] (5) · fields: id, customer, total, status');
  });

  it.each([
    ['legacy', false],
    ['pipeline', true],
  ] as const)('history: view stripped from model input with chatViews off (%s)', async (_label, withPipeline) => {
    const { registry } = invoiceTools();
    const model = scriptedModel(['Fine.']);
    const viewPart = {
      type: 'tool-render_view', toolCallId: 'call-view', state: 'output-available',
      input: tableSpec('call-old'),
      output: { shown: true, elements: 1, view: { v: 1, root: 'card', elements: { card: { type: 'Card', schemaVersion: 1, props: { title: 'SECRET-PROJECTION' } } } } },
    };
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'Assistant',
      ...(withPipeline
        ? {
            pipeline: {
              process: async (input: string) => ({
                model: { modelId: 'm' }, tools: ['invoices_list'], toolSelection: 'explicit' as const, sanitizedInput: input,
                intent: { intent: 'x', confidence: 1 }, module: null, followupsEnabled: false,
              }),
            },
          }
        : {}),
    });
    await (await handler(post([...earlierTurn([viewPart]), userMessage('u1', 'Thanks')]))).text();
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).not.toContain('SECRET-PROJECTION');
    expect(prompt).toContain('"shown":true');
    // Still off: no tool and no source memo.
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name) ?? []).not.toContain('render_view');
    expect(prompt).not.toContain('call-old ·');
  });

  it('an app tool named render_view keeps its parts in model input', async () => {
    const { registry } = invoiceTools();
    const appTool = defineTool({ id: 'render_view', description: 'App view.', inputSchema: z.object({}).strict(), execute: async () => ({ shown: true }) });
    const model = scriptedModel(['Fine.']);
    const viewPart = {
      type: 'tool-render_view', toolCallId: 'call-view', state: 'output-available', input: {},
      output: { shown: true, elements: 1, view: { v: 1, note: 'APP-OWNED-VIEW' } },
    };
    const handler = createAiChatHandler({ tools: { ...registry, render_view: appTool }, model, systemPrompt: 'Assistant', chatViews: {} });
    await (await handler(post([...earlierTurn([viewPart]), userMessage('u1', 'Thanks')]))).text();
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('APP-OWNED-VIEW');
  });

  it('source memo names no data-derived keys', async () => {
    const { registry } = invoiceTools();
    const model = scriptedModel(['Fine.']);
    const part = (toolCallId: string, output: unknown) => ({
      type: 'tool-invoices_list', toolCallId, state: 'output-available', input: {}, output,
    });
    const history = [
      userMessage('u0', 'Show'),
      {
        id: 'a0',
        role: 'assistant',
        parts: [
          // A map keyed by e-mail addresses and ids: no list, so only `value`.
          part('call-map', { success: true, 'alice@example.com': { total: 1 }, cust_12345: { total: 2 } }),
          // A list whose entries carry data-derived keys next to real field names.
          part('call-list', { success: true, data: [{ id: 'a', 'bob@example.com': 1, acct_98765: 2, total: 3 }] }),
          { type: 'text', text: 'Done.' },
        ],
      },
      userMessage('u1', 'Thanks'),
    ];
    const handler = createAiChatHandler({ tools: registry, model, systemPrompt: 'Assistant', chatViews: {} });
    await (await handler(post(history))).text();
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('call-map · invoices_list · value');
    expect(prompt).toContain('call-list · invoices_list · data[] (1) · fields: id, total');
    // The memo is one JSON string in the prompt (the history's tool parts hold the keys themselves).
    const memo = /Tool results of earlier turns(?:[^"\\]|\\.)*/.exec(prompt)![0];
    expect(memo).toContain('call-map');
    for (const key of ['alice@example.com', 'cust_12345', 'bob@example.com', 'acct_98765']) expect(memo).not.toContain(key);
  });

  it('capabilities narrow the catalog', async () => {
    const { registry } = invoiceTools();
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (call, ctx) => {
      const description = (ctx.tools.render_view as { description: string }).description;
      expect(description).toContain('Card(');
      expect(description).not.toContain('Table(');
      expect(await call('render_view', tableSpec('call-old'))).toMatchObject({ success: false, error: expect.stringContaining('Table') });
      expect(await call('render_view', cardSpec)).toMatchObject({ shown: true, elements: 1 });
    }, [...earlierTurn(), userMessage('u1', 'Table please')], { chatViews: { components: [{ id: 'Card', schemaVersion: 1 }] } });
  });

  it('ignores invalid capabilities (no narrowing)', async () => {
    const { registry } = invoiceTools();
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (_call, ctx) => {
      expect((ctx.tools.render_view as { description: string }).description).toContain('Table(');
    }, [userMessage('u1', 'Hi')], { chatViews: { components: 'all' } });
  });

  it('pii: projection stays shielded', async () => {
    const names = ['Alice Doe', 'Bob Roe'];
    const detector: PiiDetector = {
      detect(text) {
        const found: PiiEntity[] = [];
        for (const name of names) {
          for (const match of text.matchAll(new RegExp(name, 'g'))) {
            found.push({ type: 'person', start: match.index!, end: match.index! + name.length, score: 0.9, text: name });
          }
        }
        return found;
      },
    };
    const shield = createPiiShield({ locale: 'en-US', detector });
    const anonymize = vi.spyOn(shield, 'anonymizeResult');
    const rehydrate = vi.spyOn(shield, 'rehydrateArgs');
    const rehydrateAsync = shield.rehydrateArgsAsync ? vi.spyOn(shield, 'rehydrateArgsAsync') : undefined;
    const { registry } = invoiceTools(() => names.map((customer, index) => ({ id: `inv_${index}`, customer, total: 10, status: 'open' })));
    const turn = harness({ tools: registry, piiShield: shield, chatViews: {} });
    await turn.run(async (call) => {
      const listed = await call('invoices_list', {}, 'call-1') as { data: Array<{ customer: string }> };
      const pseudonyms = listed.data.map((row) => row.customer);
      for (const name of names) expect(JSON.stringify(listed)).not.toContain(name);
      expect(anonymize).toHaveBeenCalledTimes(1);
      rehydrate.mockClear();
      rehydrateAsync?.mockClear();

      const spec = { ...tableSpec('call-1'), caption: pseudonyms[0] };
      const shown = await call('render_view', spec, 'call-2') as {
        view: { caption?: string; elements: Record<string, { rows?: Array<{ cell: { label: string } }> }> };
      };
      expect(shown.view.elements.table!.rows!.map((row) => row.cell.label)).toEqual(pseudonyms);
      expect(shown.view.caption).toBe(pseudonyms[0]);
      for (const name of names) expect(JSON.stringify(shown)).not.toContain(name);
      // Neither rehydrated nor sealed again.
      expect(rehydrate).not.toHaveBeenCalled();
      if (rehydrateAsync) expect(rehydrateAsync).not.toHaveBeenCalled();
      expect(anonymize).toHaveBeenCalledTimes(1);
    });
  });

  it('pii: oversized result read from the store stays sealed', async () => {
    const names = ['Alice Doe', 'Bob Roe'];
    const detector: PiiDetector = {
      detect(text) {
        const found: PiiEntity[] = [];
        for (const name of names) {
          for (const match of text.matchAll(new RegExp(name, 'g'))) {
            found.push({ type: 'person', start: match.index!, end: match.index! + name.length, score: 0.9, text: name });
          }
        }
        return found;
      },
    };
    const shield = createPiiShield({ locale: 'en-US', detector });
    const anonymize = vi.spyOn(shield, 'anonymizeResult');
    const rehydrate = vi.spyOn(shield, 'rehydrateArgs');
    const rehydrateAsync = shield.rehydrateArgsAsync ? vi.spyOn(shield, 'rehydrateArgsAsync') : undefined;
    // 20 invoices whose long body names the customer: over the result limit, so the model sees an overview.
    const rows = () => Array.from({ length: 20 }, (_, index) => ({
      id: `inv_${index}`, customer: names[index % 2]!, total: 10, status: 'open',
      body: `${'x'.repeat(900)} for ${names[index % 2]!}`,
    }));
    const { registry } = invoiceTools(rows);
    const turn = harness({ tools: registry, piiShield: shield, chatViews: {} });
    await turn.run(async (call) => {
      const overview = await call('invoices_list', {}, 'call-1') as { _result: { omitted?: Array<{ path: string }> } };
      expect(overview._result.omitted?.map((entry) => entry.path)).toContain('data[].body');
      const sealedCalls = anonymize.mock.calls.length;
      expect(sealedCalls).toBeGreaterThan(0);
      rehydrate.mockClear();
      rehydrateAsync?.mockClear();

      const shown = await call('render_view', tableSpec('call-1', 'body'), 'call-2') as {
        view: { elements: Record<string, { rows?: Array<{ cell: { label: string } }> }> };
      };
      const labels = shown.view.elements.table!.rows!.map((row) => row.cell.label);
      // The full bodies from the store, in their sealed form: a pseudonym in place of each name.
      expect(labels).toHaveLength(20);
      for (const label of labels) expect(label).toMatch(/^x{900} for \S/);
      for (const name of names) expect(JSON.stringify(shown)).not.toContain(name);
      expect(new Set(labels).size).toBe(2);
      // Neither rehydrated nor sealed again.
      expect(rehydrate).not.toHaveBeenCalled();
      if (rehydrateAsync) expect(rehydrateAsync).not.toHaveBeenCalled();
      expect(anonymize).toHaveBeenCalledTimes(sealedCalls);
    });
  });

  it('second render_view in a turn is rejected', async () => {
    const { registry } = invoiceTools();
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (call) => {
      expect(await call('render_view', cardSpec)).toMatchObject({ shown: true });
      expect(await call('render_view', cardSpec)).toMatchObject({ success: false, error: 'one view per answer' });
    });
  });

  it('a failed render_view does not use up the view of the turn', async () => {
    const { registry } = invoiceTools();
    const turn = harness({ tools: registry, chatViews: {} });
    await turn.run(async (call) => {
      expect(await call('render_view', tableSpec('call-missing'))).toMatchObject({ success: false });
      expect(await call('render_view', cardSpec)).toMatchObject({ shown: true });
    });
  });

  it('rejects an invalid chatViews option when the handler is created', () => {
    const { registry } = invoiceTools();
    for (const bad of [{ maxViewsPerTurn: 2 }, { catalog: { v: 2, components: [] } }, { other: 1 }, 'yes']) {
      expect(() => createAiChatHandler({ tools: registry, model: {}, systemPrompt: 'A', chatViews: bad as never }))
        .toThrow(/createAiChatHandler: chatViews/);
    }
  });

  describe('managed turn: lookup through store runs the origin guard', () => {
    const big = () => invoiceRows(20, `${'x'.repeat(900)}-`);

    it('counts the read as a call of the origin tool and keeps render_view a built-in', async () => {
      const { registry } = invoiceTools(big, 'tasks_list');
      const turn = harness({ tools: registry, chatViews: {}, ...managed() });
      await turn.run(async (call, ctx) => {
        expect(ctx.handlerBuiltinToolNames).toContain('render_view');
        await call('tasks_list', {}, 'call-1');
        const tracker = ctx.managedTurn!.tracker;
        const before = tracker.usage.toolCalls;
        expect(await call('render_view', tableSpec('call-1', 'body'), 'call-2')).toMatchObject({ shown: true });
        expect(tracker.usage.toolCalls).toBe(before + 1);
      });
    });

    it('blocks the read once the origin tool is revoked mid-turn', async () => {
      let revoked: string[] = [];
      const { registry } = invoiceTools(big, 'tasks_list');
      const turn = harness({ tools: registry, chatViews: {}, ...managed({ revoked: () => revoked }) });
      await turn.run(async (call) => {
        await call('tasks_list', {}, 'call-1');
        revoked = [LIST_TASKS_ID];
        await expect(call('render_view', tableSpec('call-1', 'body'), 'call-2')).rejects.toMatchObject({
          name: 'ToolExecutionDeniedError', reason: 'revoked', toolName: 'tasks_list',
        });
      });
    });

    it('denies the full result to another principal (fail closed)', async () => {
      let current: Principal = principal();
      const { registry } = invoiceTools(big, 'tasks_list');
      const turn = harness({ tools: registry, chatViews: {}, ...managed({ current: () => current }) });
      await turn.run(async (call) => {
        await call('tasks_list', {}, 'call-1');
        current = { ...principal(), subjectId: 'bob' };
        const answer = await call('render_view', tableSpec('call-1', 'body'), 'call-2');
        expect(answer).toMatchObject({ success: false });
        expect(JSON.stringify(answer)).not.toContain('xxxx');
      });
    });
  });
});
