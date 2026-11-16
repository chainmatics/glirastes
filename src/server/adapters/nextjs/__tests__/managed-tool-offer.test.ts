import { readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal, SecurityRevocation } from '../../../../contracts/index.js';
import { createTurnSnapshot, type TurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import {
  agentRevision,
  ARCHIVE_TASK_ID,
  LIST_TASKS_ID,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
  streamChunks,
} from './command-fixtures.js';

/**
 * What a managed turn hands to the model: only the tools the principal may
 * use (pinned revisions, the principal and revocations of the request), plus
 * the handler's own built-ins. The execution guard decides every call anyway.
 */

const SECRET = 'handler-test-secret-with-32-chars!!';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const answer = [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Done.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

/** Runs the scripted steps in order, then answers with text. */
function scriptedModel(...steps: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[call];
      call += 1;
      return {
        stream: convertArrayToReadableStream((step
          ? [{ type: 'stream-start', warnings: [] }, ...step, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
          : [{ type: 'stream-start', warnings: [] }, ...answer]) as never),
      };
    },
  });
}

const toolCall = (toolName: string, input: unknown, toolCallId = 'call-1') =>
  ({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) });

/** The tool names the model was given in each step. */
const offered = (model: MockLanguageModelV3) =>
  model.doStreamCalls.map((call) => (call.tools ?? []).map((tool) => tool.name).sort());

function tools() {
  const list = vi.fn(async (_input: unknown) => ({ tasks: [] }));
  const archive = vi.fn(async (_input: unknown) => ({ success: true, archived: true }));
  const registry: ToolRegistry = {
    tasks_list: defineTool({ id: LIST_TASKS_ID, description: 'List the tasks.', inputSchema: z.object({}).strict(), execute: list }),
    tasks_archive: defineTool({ id: ARCHIVE_TASK_ID, description: 'Archive a task.', inputSchema: z.object({ id: z.string() }).strict(), execute: archive }),
  };
  return { registry, list, archive };
}

const revocation = (toolIds: string[]): SecurityRevocation => ({
  revocationId: '019fb710-0000-7000-8000-0000000000f1',
  environmentId: manifestRevision.environmentId,
  effectiveAt: '2026-10-05T08:00:00.000Z',
  reasonCode: 'incident',
  toolIds,
  agentRevisionIds: [],
  policyRevisionIds: [],
  signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'c2lnbmF0dXJl' },
});

/** Pins one snapshot per turn (list restricted to `member`), as the local runtime source does. */
function runtime(options: {
  roles?: () => string[];
  revoked?: () => string[];
  resolvePrincipal?: () => Promise<Principal | undefined>;
} = {}) {
  const roles = options.roles ?? (() => ['viewer']);
  const pinned = new Map<string, TurnSnapshot>();
  return {
    resolvePrincipal: options.resolvePrincipal ?? (async () => principal(roles())),
    resolveTurnSnapshot: async ({ turnId, principal: current }: { turnId: string; principal: Principal }) => {
      const existing = pinned.get(turnId);
      if (existing) return existing;
      const created = createTurnSnapshot({
        turnId, agentRevision, manifestRevision, policyRevision: policyRevision({ listRoles: ['member'] }), principal: current, localLimits,
      });
      pinned.set(turnId, created);
      return created;
    },
    loadRevocations: async () => (options.revoked ? [revocation(options.revoked())] : []),
  };
}

const post = (messages: unknown[]) => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
});
const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Archive t1' }] };

const pipeline = {
  process: async (input: string) => ({
    model: { modelId: 'm' }, tools: ['tasks_list', 'tasks_archive'], toolSelection: 'explicit' as const, sanitizedInput: input,
    intent: { intent: 'x', confidence: 1 }, module: null, followupsEnabled: false,
  }),
};

async function clientMessage(chunks: Array<Record<string, unknown>>): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk as never); controller.close(); } }),
  })) last = message;
  return JSON.parse(JSON.stringify(last)) as UIMessage;
}

function approve(message: UIMessage): UIMessage {
  return JSON.parse(JSON.stringify({
    ...message,
    parts: message.parts.map((part) => {
      const record = part as Record<string, unknown>;
      return record.state === 'approval-requested'
        ? { ...record, state: 'approval-responded', approval: { id: (record.approval as { id: string }).id, approved: true } }
        : part;
    }),
  }));
}

describe.each([
  ['legacy', {}],
  ['pipeline', { pipeline: pipeline as never }],
] as Array<[string, Partial<AiChatHandlerFullConfig>]>)('the tools a managed turn hands to the model (%s path)', (_path, pathConfig) => {
  const config = (overrides: Partial<AiChatHandlerFullConfig>): AiChatHandlerFullConfig => ({
    systemPrompt: 'A', approvalSecret: SECRET, intentRouting: false, ...pathConfig, ...overrides,
  } as AiChatHandlerFullConfig);

  /** The tool names handed to the stream handler and those the model was given in the first step. */
  async function offer(overrides: Partial<AiChatHandlerFullConfig>) {
    const model = scriptedModel();
    const { registry } = tools();
    await streamChunks(await createAiChatHandler(config({ tools: registry, model, ...overrides }))(post([user])));
    const handed: string[][] = [];
    await (await createAiChatHandler(config({
      tools: registry, model: scriptedModel(), ...overrides,
      streamHandler: async (ctx) => { handed.push(Object.keys(ctx.tools).sort()); return new Response('ok'); },
    }))(post([user]))).text();
    return { model: offered(model)[0], handed: handed[0] };
  }

  describe.each([[false], [true]])('with toolDiscovery %s', (toolDiscovery) => {
    const builtins = toolDiscovery ? ['find_tools'] : [];

    it('leaves out a tool the pinned policy restricts to a role the principal does not have', async () => {
      const seen = await offer({ toolDiscovery, managedRuntime: runtime() });
      expect(seen.model).toEqual([...builtins, 'tasks_archive']);
      expect(seen.handed).toEqual([...builtins, 'tasks_archive']);
    });

    it('offers that tool to a principal with the role', async () => {
      const seen = await offer({ toolDiscovery, managedRuntime: runtime({ roles: () => ['member'] }) });
      expect(seen.model).toEqual([...builtins, 'tasks_archive', 'tasks_list']);
      expect(seen.handed).toEqual([...builtins, 'tasks_archive', 'tasks_list']);
    });

    it('leaves out a revoked tool', async () => {
      const seen = await offer({
        toolDiscovery,
        managedRuntime: runtime({ roles: () => ['member'], revoked: () => [ARCHIVE_TASK_ID] }),
      });
      expect(seen.model).toEqual([...builtins, 'tasks_list']);
      expect(seen.handed).toEqual([...builtins, 'tasks_list']);
    });

    it('keeps the built-ins the handler created', async () => {
      const seen = await offer({ toolDiscovery, clarification: {}, managedRuntime: runtime() });
      expect(seen.model).toEqual([...builtins, 'ask_clarification', 'tasks_archive'].sort());
      expect(seen.handed).toEqual([...builtins, 'ask_clarification', 'tasks_archive'].sort());
    });

    it('hands over every registry tool again with authorizedToolsOnly: false', async () => {
      const seen = await offer({ toolDiscovery, authorizedToolsOnly: false, managedRuntime: runtime() });
      expect(seen.handed).toEqual([...builtins, 'tasks_archive', 'tasks_list']);
      // Discovery activates only what the principal may use, as before.
      expect(seen.model).toEqual(toolDiscovery ? ['find_tools', 'tasks_archive'] : ['tasks_archive', 'tasks_list']);
    });
  });

  it('leaves a turn without managedRuntime as it was', async () => {
    const seen = await offer({});
    expect(seen.model).toEqual(['tasks_archive', 'tasks_list']);
    expect(seen.handed).toEqual(['tasks_archive', 'tasks_list']);
  });

  it('does not run a call to a tool that was left out', async () => {
    const { registry, list } = tools();
    const model = scriptedModel([toolCall('tasks_list', {})]);
    const response = await createAiChatHandler(config({ tools: registry, model, managedRuntime: runtime() }))(post([user]));
    expect(response.status).toBe(200);
    await streamChunks(response);
    expect(list).not.toHaveBeenCalled();
  });

  it('still denies the call in the guard with authorizedToolsOnly: false', async () => {
    const { registry, list } = tools();
    const model = scriptedModel([toolCall('tasks_list', {})]);
    const chunks = await streamChunks(await createAiChatHandler(config({
      tools: registry, model, authorizedToolsOnly: false, managedRuntime: runtime(),
    }))(post([user])));
    expect(offered(model)[0]).toContain('tasks_list');
    expect(list).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === 'tool-output-available')).toBe(false);
  });

  describe('an approval answered in a later request', () => {
    async function firstTurn(roles: () => string[]) {
      const { registry, archive } = tools();
      const model = scriptedModel([toolCall('tasks_archive', { id: 't1' })]);
      const handler = createAiChatHandler(config({
        tools: registry, model,
        managedRuntime: runtime({ roles, revoked: () => (roles().includes('revoked') ? [ARCHIVE_TASK_ID] : []) }),
      }));
      const first = await streamChunks(await handler(post([user])));
      expect(first.find((chunk) => chunk.type === 'tool-approval-request')).toMatchObject({ toolCallId: 'call-1' });
      return { handler, archive, model, answered: approve(await clientMessage(first)) };
    }

    it('runs the approved call of a tool the principal may still use', async () => {
      const { handler, archive, answered } = await firstTurn(() => ['viewer']);
      const second = await streamChunks(await handler(post([user, answered])));
      expect(archive).toHaveBeenCalledTimes(1);
      expect(second.some((chunk) => chunk.type === 'tool-output-error')).toBe(false);
    });

    it('ends the approved call of a tool revoked since as a tool error, without failing the request', async () => {
      let roles = ['viewer'];
      const { handler, archive, model, answered } = await firstTurn(() => roles);
      // The fixture reads this marker role as "the archive tool is revoked now".
      roles = ['viewer', 'revoked'];
      const response = await handler(post([user, answered]));
      expect(response.status).toBe(200);
      const second = await streamChunks(response);
      expect(archive).not.toHaveBeenCalled();
      expect(second).toContainEqual(expect.objectContaining({ type: 'tool-output-error', toolCallId: 'call-1' }));
      expect(second.some((chunk) => chunk.type === 'error')).toBe(false);
      // The tool only stays so the approved call gets its tool error; what it does is not described again.
      expect(JSON.stringify(model.doStreamCalls.at(-1)!.tools)).not.toContain('Archive a task.');
    });
  });
});
