import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ExecutionBudget, Principal, SecurityRevocation } from '../../../../contracts/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createPiiShield } from '../../../pii-shield/index.js';
import { defineTool, type PiiDetector, type PiiEntity, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler, type AiChatHandlerFullConfig, type StreamHandlerContext } from '../create-ai-chat-handler.js';
import {
  agentRevision, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal,
} from './command-fixtures.js';

const SECRET = 'result-handle-test-secret-32-chars!!';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** 20 tasks of ~8,000 characters each: over the default limit of 16,000. */
const bigTasks = () => ({
  success: true,
  tasks: Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, title: `Task ${index}`, body: `b${index}-${'x'.repeat(8_000)}` })),
});

function taskTools(extra: ToolRegistry = {}) {
  const list = vi.fn(async (_input: unknown) => bigTasks());
  const registry: ToolRegistry = {
    tasks_list: defineTool({ id: LIST_TASKS_ID, description: 'List tasks.', inputSchema: z.object({}).strict(), execute: list }),
    ...extra,
  };
  return { list, registry };
}

const post = () => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
});

type Call = (name: string, input: unknown) => Promise<Record<string, unknown>>;
type Overview = Record<string, unknown> & { _result: { id: string; omitted?: Array<{ path: string }> } };

/**
 * A handler whose custom stream handler runs `script` with the tools of the
 * request, calling them as the AI SDK does (approval check, then execute).
 */
function harness(config: Partial<AiChatHandlerFullConfig>) {
  let script: (call: Call, ctx: StreamHandlerContext) => Promise<void> = async () => undefined;
  let failure: unknown;
  let callIds = 0;
  const handler = createAiChatHandler({
    model: {},
    systemPrompt: 'Assistant',
    ...config,
    streamHandler: async (ctx) => {
      const call: Call = async (name, input) => {
        const tool = ctx.tools[name] as {
          needsApproval?: (input: unknown, options: unknown) => unknown;
          execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
        };
        const options = { toolCallId: `call-${callIds += 1}`, messages: [] };
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
    async run(next: typeof script) {
      script = next;
      failure = undefined;
      const response = await handler(post());
      await response.text();
      if (failure) throw failure;
      return response;
    },
  };
}

const revocationOf = (toolIds: string[]): SecurityRevocation => ({
  revocationId: '019fb710-0000-7000-8000-0000000000d1',
  environmentId: manifestRevision.environmentId,
  effectiveAt: new Date(0).toISOString(),
  reasonCode: 'security-disable',
  toolIds,
  agentRevisionIds: [],
  policyRevisionIds: [],
  signature: agentRevision.signature,
});

function managed(options: {
  current?: () => Principal | undefined;
  revoked?: () => string[];
  limits?: Partial<ExecutionBudget>;
} = {}) {
  const resolvePrincipal = vi.fn(async () => (options.current ? options.current() : principal()));
  return {
    resolvePrincipal,
    config: {
      approvalSecret: SECRET,
      managedRuntime: {
        resolvePrincipal,
        resolveTurnSnapshot: async ({ turnId }: { turnId: string }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
          localLimits: { ...localLimits, ...options.limits },
        }),
        loadRevocations: async () => {
          const revoked = options.revoked?.() ?? [];
          return revoked.length > 0 ? [revocationOf(revoked)] : [];
        },
      },
    } satisfies Partial<AiChatHandlerFullConfig>,
  };
}

describe('result handles in createAiChatHandler', () => {
  it('validates resultHandles when the handler is created', () => {
    const { registry } = taskTools();
    for (const bad of [{ maxResults: 0 }, { maxResultBytes: 1.5 }, { maxTotalBytes: -1 }, { other: 1 }, 'yes', null]) {
      expect(() => createAiChatHandler({ tools: registry, model: {}, systemPrompt: 'A', resultHandles: bad as never }))
        .toThrow(/createAiChatHandler: resultHandles/);
    }
  });

  it('binds a handle to its request: the same handler, user and id answer result_expired in the next request', async () => {
    const { registry, list } = taskTools();
    const turn = harness({ tools: registry });
    let id = '';
    await turn.run(async (call) => {
      const overview = await call('tasks_list', {}) as Overview;
      id = overview._result.id;
      expect(overview._result.omitted?.[0]?.path).toBe('tasks[].body');
      const read = await call('read_result', { resultId: id, fields: ['tasks[].body'], offset: 3, limit: 1 });
      expect(read.tasks).toEqual([{ body: `b3-${'x'.repeat(8_000)}` }]);
    });
    expect(id).toMatch(/^ro_[0-9a-z]{8}$/);
    await turn.run(async (call) => {
      expect(await call('read_result', { resultId: id })).toMatchObject({ error: 'result_expired' });
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('never runs a write tool again for a read', async () => {
    const write = vi.fn(async () => bigTasks());
    const turn = harness({
      tools: { tasks_import: defineTool({ id: 'tasks.import', description: 'Import.', method: 'POST', inputSchema: z.object({}), execute: write }) },
    });
    await turn.run(async (call) => {
      const overview = await call('tasks_import', {}) as Overview;
      expect(overview._result.id).toMatch(/^rw_/);
      for (const offset of [0, 5, 10]) {
        expect(await call('read_result', { resultId: overview._result.id, fields: ['tasks[].body'], offset, limit: 1 }))
          .toHaveProperty('tasks');
      }
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('clears the store when the turn ends', async () => {
    const { registry } = taskTools();
    let read: ((input: unknown) => Promise<unknown>) | undefined;
    let id = '';
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'A',
      streamHandler: async (ctx) => {
        const overview = await (ctx.tools.tasks_list as { execute: (input: unknown, options: unknown) => Promise<Overview> })
          .execute({}, { toolCallId: 'c1', messages: [] });
        id = overview._result.id;
        const tool = ctx.tools.read_result as { execute: (input: unknown, options: unknown) => Promise<unknown> };
        read = (input) => tool.execute(input, { toolCallId: 'c2', messages: [] });
        expect(await read({ resultId: id })).toHaveProperty('_result');
        return new Response('streamed body');
      },
    });
    const response = await handler(post());
    expect(await read!({ resultId: id })).toHaveProperty('_result');
    expect(await response.text()).toBe('streamed body');
    expect(await read!({ resultId: id })).toMatchObject({ error: 'result_expired' });
  });

  it('cuts as before with resultHandles: false and offers no read_result', async () => {
    const { registry } = taskTools();
    const turn = harness({ tools: registry, resultHandles: false });
    await turn.run(async (call, ctx) => {
      expect(Object.keys(ctx.tools)).not.toContain('read_result');
      const result = await call('tasks_list', {});
      expect(result).toHaveProperty('_truncated');
      expect(result).not.toHaveProperty('_result');
    });
  });

  it('honours custom limits: a result beyond them is cut', async () => {
    const { registry } = taskTools();
    const turn = harness({ tools: registry, resultHandles: { maxResults: 1 } });
    await turn.run(async (call) => {
      expect(await call('tasks_list', {})).toHaveProperty('_result');
      const second = await call('tasks_list', {});
      expect(second).toHaveProperty('_truncated');
      expect(second).not.toHaveProperty('_result');
    });
  });

  it('keeps a registry tool named read_result as a domain tool', async () => {
    const own = vi.fn(async () => ({ own: true }));
    const { registry } = taskTools({
      read_result: defineTool({ id: 'app.read_result', description: 'App tool.', inputSchema: z.object({}).passthrough(), execute: own }),
    });
    const turn = harness({ tools: registry });
    await turn.run(async (call, ctx) => {
      expect(ctx.handlerBuiltinToolNames).not.toContain('read_result');
      expect(await call('read_result', { resultId: 'ro_00000000' })).toEqual({ own: true });
      // The turn then keeps no handles: an overview would point to a tool the model cannot use.
      const listed = await call('tasks_list', {});
      expect(listed).toHaveProperty('_truncated');
      expect(listed).not.toHaveProperty('_result');
    });
    expect(own).toHaveBeenCalledTimes(1);
  });

  describe('in a managed turn', () => {
    it('resolves the principal afresh for every read and denies another subject or tenant', async () => {
      let current: Principal = principal();
      const runtime = managed({ current: () => current });
      const { registry, list } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        expect(ctx.handlerBuiltinToolNames).toContain('read_result');
        const overview = await call('tasks_list', {}) as Overview;
        const before = runtime.resolvePrincipal.mock.calls.length;
        expect(await call('read_result', { resultId: overview._result.id, fields: ['tasks[].title'] })).toHaveProperty('tasks');
        const afterOne = runtime.resolvePrincipal.mock.calls.length;
        expect(afterOne).toBeGreaterThan(before);
        await call('read_result', { resultId: overview._result.id, fields: ['tasks[].id'] });
        expect(runtime.resolvePrincipal.mock.calls.length).toBeGreaterThan(afterOne);

        current = { ...principal(), subjectId: 'bob' };
        expect(await call('read_result', { resultId: overview._result.id })).toMatchObject({ error: 'result_denied' });
        current = { ...principal(), tenantId: '019fb710-0000-7000-8000-0000000000ff' };
        expect(await call('read_result', { resultId: overview._result.id })).toMatchObject({ error: 'result_denied' });
        current = principal();
        expect(await call('read_result', { resultId: overview._result.id, fields: ['tasks[].id'], limit: 1 }))
          .toHaveProperty('tasks');
      });
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('blocks reads once the origin tool is revoked mid-turn', async () => {
      let revoked: string[] = [];
      const runtime = managed({ revoked: () => revoked });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call) => {
        const overview = await call('tasks_list', {}) as Overview;
        revoked = [LIST_TASKS_ID];
        await expect(call('read_result', { resultId: overview._result.id })).rejects.toMatchObject({
          name: 'ToolExecutionDeniedError', reason: 'revoked', toolName: 'tasks_list',
        });
      });
    });

    it('counts every read toward maxToolCalls as a call of the origin tool', async () => {
      const runtime = managed({ limits: { maxToolCalls: 2 } });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        // The custom stream handler calls the domain tool without the guard; read_result guards itself.
        const overview = await call('tasks_list', {}) as Overview;
        const tracker = ctx.managedTurn!.tracker;
        await call('read_result', { resultId: overview._result.id, fields: ['tasks[].id'] });
        expect(tracker.usage.toolCalls).toBe(1);
        await call('read_result', { resultId: overview._result.id, fields: ['tasks[].title'] });
        expect(tracker.usage.toolCalls).toBe(2);
        expect(await call('read_result', { resultId: overview._result.id, fields: ['tasks[].body'] }))
          .toMatchObject({ error: 'budget_exhausted' });
        expect(tracker.usage.toolCalls).toBe(2);
      });
    });

    it('trips loop detection for identical reads, not for different fields or offsets', async () => {
      const runtime = managed({ limits: { maxToolCalls: 20, maxRepeatedFingerprint: 3 } });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        const overview = await call('tasks_list', {}) as Overview;
        const tracker = ctx.managedTurn!.tracker;
        const resultId = overview._result.id;
        await call('read_result', { resultId, fields: ['tasks[].id'] });
        await call('read_result', { resultId, fields: ['tasks[].title'] });
        await call('read_result', { resultId, fields: ['tasks[].id'], offset: 5 });
        expect(tracker.usage.maxFingerprintRepeats).toBe(1);
        expect(tracker.evaluate().state).not.toBe('hard-limit');
        await call('read_result', { resultId, fields: ['tasks[].id'] });
        await call('read_result', { resultId, fields: ['tasks[].id'] });
        expect(tracker.usage.maxFingerprintRepeats).toBe(3);
        expect(tracker.evaluate()).toMatchObject({ state: 'hard-limit', reasons: expect.arrayContaining(['maxRepeatedFingerprint']) });
      });
    });
  });

  describe('with the PII shield', () => {
    const names = ['Alice Doe', 'Bob Roe'];
    /** Finds "First Last" names only when the text also carries the `customerName` field. */
    const contextDetector: PiiDetector = {
      detect(text) {
        if (!text.includes('"customerName"')) return [];
        const found: PiiEntity[] = [];
        for (const match of text.matchAll(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g)) {
          found.push({ type: 'person', start: match.index!, end: match.index! + match[0].length, score: 0.9, text: match[0] });
        }
        return found;
      },
    };

    function shieldedTools() {
      const lookup = vi.fn(async (input: { name: string }) => ({ found: input.name === 'Alice Doe', name: input.name }));
      const registry: ToolRegistry = {
        customers_list: defineTool({
          id: 'customers.list', description: 'List customers.', inputSchema: z.object({}),
          execute: async () => ({
            success: true,
            customers: Array.from({ length: 20 }, (_, index) => ({
              id: `c${index}`,
              customerName: names[index % 2],
              notes: `call back ${names[index % 2]} ${'n'.repeat(8_000)}`,
            })),
          }),
        }),
        customer_lookup: defineTool({
          id: 'customers.lookup', description: 'Look up a customer.', inputSchema: z.object({ name: z.string() }), execute: lookup,
        }),
      };
      return { registry, lookup };
    }

    it.each([['legacy', false], ['pipeline', true]] as const)(
      'seals a stored result once and shows the same pseudonyms everywhere (%s path)',
      async (_path, withPipeline) => {
        const shield = createPiiShield({ locale: 'en-US', detector: contextDetector });
        const anonymize = vi.spyOn(shield, 'anonymizeResult');
        const { registry, lookup } = shieldedTools();
        const turn = harness({
          tools: registry,
          piiShield: shield,
          ...(withPipeline
            ? {
                pipeline: {
                  process: async (input: string) => ({
                    model: { modelId: 'm' }, tools: [], sanitizedInput: input, intent: { intent: 'x', confidence: 1 },
                    module: null, followupsEnabled: false,
                  }),
                },
              }
            : {}),
        });
        await turn.run(async (call) => {
          const overview = await call('customers_list', {}) as Overview & { customers: Array<{ customerName: string }> };
          expect(anonymize).toHaveBeenCalledTimes(1);
          const alias = overview.customers[0]!.customerName;
          expect(alias).not.toBe('Alice Doe');
          expect(alias).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);

          // The notes alone carry no customerName: shielded separately, the detector would miss the name.
          const notes = await call('read_result', { resultId: overview._result.id, fields: ['customers[].notes'], limit: 2 });
          const namesOnly = await call('read_result', { resultId: overview._result.id, fields: ['customers[].customerName'] });
          const everything = await call('read_result', { resultId: overview._result.id, offset: 0, limit: 1 });
          for (const shown of [overview, notes, namesOnly, everything]) {
            for (const original of names) expect(JSON.stringify(shown)).not.toContain(original);
          }
          expect((notes.customers as Array<{ notes: string }>)[0]!.notes).toContain(`call back ${alias} `);
          expect((namesOnly.customers as Array<{ customerName: string }>)[0]!.customerName).toBe(alias);
          expect((everything.customers as Array<{ customerName: string }>)[0]!.customerName).toBe(alias);
          // No double shielding: overview and reads were cut from the copy sealed once.
          expect(anonymize).toHaveBeenCalledTimes(1);

          // Later tool arguments are still rehydrated; a result without a handle is shielded as before.
          const found = await call('customer_lookup', { name: alias });
          expect(lookup).toHaveBeenCalledWith({ name: 'Alice Doe' }, expect.anything());
          expect(anonymize).toHaveBeenCalledTimes(2);
          expect(found).toEqual({ found: true, name: alias });
        });
      },
    );
  });
});

describe('result handles end to end with the built-in stream handler', () => {
  /** Calls tasks_list, then read_result with the id the model was shown, then answers. */
  function readingModel(onStep?: (step: number) => void) {
    let step = 0;
    return new MockLanguageModelV3({
      doStream: async (options) => {
        step += 1;
        onStep?.(step);
        const prompt = JSON.stringify(options.prompt);
        const id = /r[ow]_[0-9a-z]{8}/.exec(prompt)?.[0];
        const chunks = step === 1
          ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'tasks_list', input: '{}' }]
          : step === 2
            ? [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'read_result', input: JSON.stringify({ resultId: id, fields: ['tasks[].body'], offset: 7, limit: 1 }) }]
            : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }];
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...chunks,
            { type: 'finish', finishReason: { unified: step < 3 ? 'tool-calls' : 'stop', raw: undefined }, usage },
          ] as never),
        };
      },
    });
  }

  it.each([
    ['legacy', false, false],
    ['pipeline', true, false],
    ['legacy managed', false, true],
    ['pipeline managed', true, true],
  ] as const)('reads more of a large result without calling the tool again (%s)', async (_label, withPipeline, isManaged) => {
    const { registry, list } = taskTools();
    const model = readingModel();
    const onError = vi.fn();
    const handler = createAiChatHandler({
      tools: registry,
      model,
      systemPrompt: 'Assistant',
      onError,
      ...(isManaged ? managed().config : {}),
      ...(withPipeline
        ? {
            pipeline: {
              process: async (input: string) => ({
                model: { modelId: 'm' }, tools: ['tasks_list'], toolSelection: 'explicit' as const, sanitizedInput: input,
                intent: { intent: 'x', confidence: 1 }, module: null, followupsEnabled: false,
              }),
            },
          }
        : {}),
    });
    const wire = await (await handler(post())).text();
    expect(onError).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[0]!.tools?.map((tool) => tool.name)).toContain('read_result');
    expect(wire).toContain('"_result"');
    expect(wire).toContain(`b7-${'x'.repeat(50)}`);
    expect(wire).toContain('Done.');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('ends a managed turn like a domain tool when the origin tool is revoked before the read', async () => {
    let revoked: string[] = [];
    const { registry } = taskTools();
    const onError = vi.fn();
    // The revocation lands after the list result reached the model, before it reads.
    const model = readingModel((step) => { if (step === 2) revoked = [LIST_TASKS_ID]; });
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'Assistant', onError, ...managed({ revoked: () => revoked }).config,
      authorizedToolsOnly: false,
    });
    const wire = await (await handler(post())).text();
    expect(wire).toContain('"type":"error"');
    expect(wire).not.toContain(`b7-${'x'.repeat(50)}`);
    expect(String(onError.mock.calls[0]?.[0])).toContain('Tool execution denied: revoked (tasks_list)');
  });
});

describe('review fixes', () => {
  describe('PII: read_result is no pseudonym oracle', () => {
    const NAME = 'Alice Doe';
    const MAIL = 'alice.doe@corp.example';
    const detector: PiiDetector = {
      detect(text) {
        const found: PiiEntity[] = [];
        for (const [pattern, type] of [[/Alice Doe/g, 'person'], [/alice\.doe@corp\.example/g, 'email']] as const) {
          for (const match of text.matchAll(pattern)) {
            found.push({ type, start: match.index!, end: match.index! + match[0].length, score: 0.9, text: match[0] });
          }
        }
        return found;
      },
    };

    it.each([
      ['legacy', false, false],
      ['pipeline', false, true],
      ['managed legacy', true, false],
      ['managed pipeline', true, true],
    ] as const)('never returns an original for pseudonyms as fields or id (%s)', async (_label, isManaged, withPipeline) => {
      const shield = createPiiShield({ locale: 'en-US', detector });
      const rehydrate = vi.spyOn(shield, 'rehydrateArgs');
      const lookup = vi.fn(async (input: { name: string }) => ({ ok: input.name === NAME }));
      const registry: ToolRegistry = {
        tasks_list: defineTool({
          id: LIST_TASKS_ID, description: 'List.', inputSchema: z.object({}).strict(),
          execute: async () => ({
            success: true,
            tasks: Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, owner: NAME, mail: MAIL, body: 'x'.repeat(8_000) })),
          }),
        }),
        customer_lookup: defineTool({ id: 'customers.lookup', description: 'Look up.', inputSchema: z.object({ name: z.string() }), execute: lookup }),
      };
      const turn = harness({
        tools: registry, piiShield: shield,
        ...(isManaged ? { ...managed().config, authorizedToolsOnly: false } : {}),
        ...(withPipeline
          ? {
              pipeline: {
                process: async (input: string) => ({
                  model: { modelId: 'm' }, tools: [], sanitizedInput: input, intent: { intent: 'x', confidence: 1 },
                  module: null, followupsEnabled: false,
                }),
              },
            }
          : {}),
      });
      await turn.run(async (call) => {
        const overview = await call('tasks_list', {}) as Overview & { tasks: Array<{ owner: string; mail: string }> };
        const rehydratedBefore = rehydrate.mock.calls.length;
        const alias = overview.tasks[0]!.owner;
        const mailAlias = overview.tasks[0]!.mail;
        expect(alias).not.toBe(NAME);
        const answers = [
          await call('read_result', { resultId: overview._result.id, fields: [alias, mailAlias, `tasks[].${alias}`, `${mailAlias}[]`] }),
          await call('read_result', { resultId: overview._result.id, fields: ['tasks[].owner', alias] }),
          await call('read_result', { resultId: alias }),
          await call('read_result', { resultId: mailAlias.slice(0, 64) }),
          await call('read_result', { resultId: overview._result.id, fields: [`[${alias}]`] }),
        ];
        answers.forEach((answer, index) => {
          const text = JSON.stringify(answer);
          expect(text).not.toContain(NAME);
          expect(text).not.toContain(MAIL);
          // Only selected data may carry the pseudonym; nothing the model wrote is echoed.
          if (index !== 1) expect(text).not.toContain(alias);
        });
        expect((answers[0]!._result as { unknownFields: number[] }).unknownFields).toEqual([1, 2, 3, 4]);
        // The handler's own read_result never has its arguments rehydrated.
        expect(rehydrate.mock.calls.length).toBe(rehydratedBefore);
        // A normal domain tool in the same turn still gets the original.
        expect(await call('customer_lookup', { name: alias })).toEqual({ ok: true });
        expect(lookup).toHaveBeenCalledWith({ name: NAME }, expect.anything());
        expect(rehydrate.mock.calls.length).toBe(rehydratedBefore + 1);
      });
    });
  });

  describe('reads that read nothing count on the managed budget', () => {
    const limits = { maxToolCalls: 3, maxConsecutiveErrors: 10 };

    it.each([
      ['an unknown id', () => ({ resultId: 'ro_00000000' }), 'result_expired'],
      ['invalid fields', (id: string) => ({ resultId: id, fields: ['a..b'] }), 'invalid_fields'],
    ] as const)('counts %s as a call and an error, then answers budget_exhausted', async (_label, input, code) => {
      const runtime = managed({ limits });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        const overview = await call('tasks_list', {}) as Overview;
        const tracker = ctx.managedTurn!.tracker;
        for (let index = 1; index <= 3; index += 1) {
          expect(await call('read_result', input(overview._result.id))).toMatchObject({ error: code });
          expect(tracker.usage.toolCalls).toBe(index);
          expect(tracker.usage.consecutiveErrors).toBe(index);
        }
        expect(await call('read_result', input(overview._result.id))).toMatchObject({ error: 'budget_exhausted' });
        expect(tracker.usage.toolCalls).toBe(3);
      });
    });

    it('counts a read of another principal\'s handle as a call and an error', async () => {
      let current: Principal = principal();
      const runtime = managed({ current: () => current, limits });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        const overview = await call('tasks_list', {}) as Overview;
        current = { ...principal(), subjectId: 'bob' };
        const tracker = ctx.managedTurn!.tracker;
        for (let index = 1; index <= 3; index += 1) {
          expect(await call('read_result', { resultId: overview._result.id })).toMatchObject({ error: 'result_denied' });
          expect(tracker.usage.toolCalls).toBe(index);
          expect(tracker.usage.consecutiveErrors).toBe(index);
        }
        expect(await call('read_result', { resultId: overview._result.id })).toMatchObject({ error: 'budget_exhausted' });
      });
    });

    it('bounds parallel calls in one step', async () => {
      const runtime = managed({ limits });
      const { registry } = taskTools();
      const turn = harness({ tools: registry, ...runtime.config });
      await turn.run(async (call, ctx) => {
        const answers = await Promise.all(Array.from({ length: 6 }, () => call('read_result', { resultId: 'rw_00000000' })));
        const codes = answers.map((answer) => answer.error).sort();
        expect(codes).toEqual(['budget_exhausted', 'budget_exhausted', 'budget_exhausted', 'result_expired', 'result_expired', 'result_expired']);
        expect(ctx.managedTurn!.tracker.usage.toolCalls).toBe(3);
      });
    });
  });

  describe('cleanup', () => {
    async function turnWithBody(body: ReadableStream<Uint8Array>) {
      const { registry } = taskTools();
      let read: (input: unknown) => Promise<unknown> = async () => undefined;
      let id = '';
      const handler = createAiChatHandler({
        tools: registry, model: {}, systemPrompt: 'A',
        streamHandler: async (ctx) => {
          const overview = await (ctx.tools.tasks_list as { execute: (input: unknown, options: unknown) => Promise<Overview> })
            .execute({}, { toolCallId: 'c1', messages: [] });
          id = overview._result.id;
          const tool = ctx.tools.read_result as { execute: (input: unknown, options: unknown) => Promise<unknown> };
          read = (input) => tool.execute(input, { toolCallId: 'c2', messages: [] });
          return new Response(body);
        },
      });
      const response = await handler(post());
      expect(await read({ resultId: id })).toHaveProperty('_result');
      return { response, readAgain: () => read({ resultId: id }) };
    }

    it('clears the store when the client cancels the stream', async () => {
      const { response, readAgain } = await turnWithBody(new ReadableStream({ pull() { /* never ends */ } }));
      await response.body!.cancel();
      expect(await readAgain()).toMatchObject({ error: 'result_expired' });
    });

    it('clears the store when the stream fails', async () => {
      const { response, readAgain } = await turnWithBody(new ReadableStream({ pull(controller) { controller.error(new Error('boom')); } }));
      await expect(response.text()).rejects.toThrow('boom');
      expect(await readAgain()).toMatchObject({ error: 'result_expired' });
    });
  });

  it('counts the domain tool and the read through the real guarded wrapper (managed, built-in stream handler)', async () => {
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        step += 1;
        const id = /r[ow]_[0-9a-z]{8}/.exec(JSON.stringify(options.prompt))?.[0];
        const read = (callId: string, fields: string[]) => ({
          type: 'tool-call', toolCallId: callId, toolName: 'read_result', input: JSON.stringify({ resultId: id, fields }),
        });
        const chunks = step === 1
          ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'tasks_list', input: '{}' }]
          : step === 2
            ? [read('call-2', ['tasks[].id'])]
            : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }];
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...chunks,
            { type: 'finish', finishReason: { unified: step < 3 ? 'tool-calls' : 'stop', raw: undefined }, usage },
          ] as never),
        };
      },
    });
    const { registry, list } = taskTools();
    const handler = createAiChatHandler({
      tools: registry, model, systemPrompt: 'A', ...managed({ limits: { maxToolCalls: 2 } }).config,
    });
    const wire = await (await handler(post())).text();
    expect(list).toHaveBeenCalledTimes(1);
    expect(wire).toContain('"_result"');
    // tasks_list (guarded wrapper) and the read both counted: maxToolCalls 2 is reached, the last step gets no tools.
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[2]!.tools ?? []).toHaveLength(0);
    expect(wire).toContain('Stopped at runtime budget: maxToolCalls.');
  });
});

describe('read_result arguments and the async rehydration path', () => {
  it('never calls rehydrateArgsAsync for the handler\'s own read_result', async () => {
    const shield = createPiiShield({ locale: 'en-US', detector: { detect: () => [] } });
    const rehydrateAsync = vi.fn(async (args: Record<string, unknown>) => args);
    shield.rehydrateArgsAsync = rehydrateAsync;
    const { registry } = taskTools();
    const turn = harness({ tools: registry, piiShield: shield });
    await turn.run(async (call) => {
      const overview = await call('tasks_list', {}) as Overview;
      const before = rehydrateAsync.mock.calls.length;
      await call('read_result', { resultId: overview._result.id, fields: ['tasks[].id'] });
      await call('read_result', { resultId: 'ro_00000000' });
      expect(rehydrateAsync.mock.calls.length).toBe(before);
      await call('tasks_list', {});
      expect(rehydrateAsync.mock.calls.length).toBe(before + 1);
    });
  });
});

describe('the owner of a handle is the principal the origin tool ran for', () => {
  const otherTenant = '019fb710-0000-7000-8000-0000000000ff';

  it.each([
    ['subject', () => ({ ...principal(), subjectId: 'bob' })],
    ['tenant', () => ({ ...principal(), tenantId: otherTenant })],
  ] as const)('creates no handle when the %s changes while the tool runs', async (_label, switched) => {
    let current: Principal = principal();
    const runtime = managed({ current: () => current });
    let release: () => void = () => undefined;
    const slow = vi.fn(async () => {
      // The principal switches while the backend call is in flight.
      await new Promise<void>((resolve) => { release = resolve; current = switched(); setTimeout(resolve, 5); });
      return bigTasks();
    });
    const turn = harness({
      tools: { tasks_list: defineTool({ id: LIST_TASKS_ID, description: 'List.', inputSchema: z.object({}).strict(), execute: slow }) },
      ...runtime.config,
    });
    await turn.run(async (call) => {
      const result = await call('tasks_list', {});
      release();
      expect(result).toHaveProperty('_truncated');
      expect(result).not.toHaveProperty('_result');
      // Nothing produced for the first principal is readable, by any id.
      expect(await call('read_result', { resultId: 'ro_00000000' })).toMatchObject({ error: 'result_expired' });
    });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('keeps the handle when the principal stays, with one resolve before and one after the tool', async () => {
    const runtime = managed();
    const { registry } = taskTools();
    const turn = harness({ tools: registry, ...runtime.config });
    await turn.run(async (call) => {
      const before = runtime.resolvePrincipal.mock.calls.length;
      const overview = await call('tasks_list', {}) as Overview;
      expect(overview._result.id).toMatch(/^ro_/);
      expect(runtime.resolvePrincipal.mock.calls.length - before).toBe(2);
      const small = await call('read_result', { resultId: overview._result.id, fields: ['tasks[].id'] });
      expect(small).toHaveProperty('tasks');
    });
  });

  it('denies a read when the principal changes while the read guard runs', async () => {
    let current: Principal = principal();
    let resolves = 0;
    let switchAt = Number.POSITIVE_INFINITY;
    const runtime = managed({
      current: () => {
        resolves += 1;
        if (resolves >= switchAt) current = { ...principal(), subjectId: 'bob' };
        return current;
      },
    });
    const { registry } = taskTools();
    const turn = harness({ tools: registry, ...runtime.config });
    await turn.run(async (call, ctx) => {
      const overview = await call('tasks_list', {}) as Overview;
      // precheck (owner + guard) and the first owner check of beforeRead see alice; the guard's own resolve onward sees bob.
      switchAt = resolves + 4;
      const answer = await call('read_result', { resultId: overview._result.id });
      expect(answer).toMatchObject({ error: 'result_denied' });
      expect(answer).not.toHaveProperty('tasks');
      expect(ctx.managedTurn!.tracker.usage.consecutiveErrors).toBeGreaterThan(0);
    });
  });
});
