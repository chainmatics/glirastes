import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import {
  TechnicalRuntimeEventV2Schema,
  type ExecutionBudget,
  type TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import { defineEndpointTool, type PiiDetector } from '../../../../types.js';
import {
  endpointToolToTool,
  type InternalApiResponse,
  type ToolFailureClassifier,
} from '../../../core/index.js';
import { createPiiShield } from '../../../pii-shield/index.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiChatHandlerConfig } from '../types.js';
import { collectingSink as commandSink, streamChunks } from './command-fixtures.js';

const LIST_TASKS_ID = agentRevision.toolAllowlist[0]!;
const NAME = 'Max Müller';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolStep(callId = 'call-1') {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: callId, toolName: 'list_tasks', input: JSON.stringify({ query: callId }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  ] as never);
}

function textStep() {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Erledigt.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  ] as never);
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

function collectingSink() {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: '019fb900-0000-7000-8000-0000000000a1',
      environmentId: '019fb900-0000-7000-8000-0000000000e1',
      buildId: null,
      instanceId: 'web-1',
    },
    record: (event) => { if (event.eventType === 'turn.finished') events.push(event); },
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

const listTasks = endpointToolToTool(defineEndpointTool({
  id: LIST_TASKS_ID,
  toolName: 'list_tasks',
  description: 'List visible tasks.',
  method: 'GET',
  path: '/api/tasks',
  inputSchema: z.object({ query: z.string() }),
}));

const forbidden: InternalApiResponse = {
  ok: false,
  status: 403,
  data: { code: 'NO_ROLE', owner: NAME },
  error: 'Forbidden',
};

const expectForbidden: ToolFailureClassifier = ({ status, body }) =>
  status === 403 && (body as { code?: unknown }).code === 'NO_ROLE' ? 'expected' : 'error';

function request(text = 'Zeige Aufgaben') {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
  });
}

async function runTurn(config: Partial<AiChatHandlerConfig> & { steps?: Array<() => ReadableStream> }) {
  const { sink, events } = collectingSink();
  const onFinish = vi.fn();
  const { steps, ...rest } = config;
  const model = scriptedModel(steps ?? [() => toolStep(), () => textStep()]);
  const handler = createAiChatHandler({
    tools: { list_tasks: listTasks },
    model,
    systemPrompt: 'Assistant',
    managedRuntime: managedRuntime(),
    metrics: sink,
    endpointCaller: () => async () => forbidden,
    onFinish,
    ...rest,
  });
  const wire = await (await handler(request())).text();
  return { events, onFinish, model, wire };
}

describe('classifyToolFailure in the Next chat handler', () => {
  it('counts a failed backend call as a tool error by default', async () => {
    const { events, onFinish, wire } = await runTurn({});
    expect(events[0]).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 1 }],
    });
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ expectedToolFailureCount: 0 }));
    // The model and the client see status and body.
    expect(wire).toContain('"status":403');
    expect(wire).toContain('"code":"NO_ROLE"');
    expect(wire).not.toContain('expectedFailure');
  });

  it('keeps an expected failure out of the error metrics and counts it locally', async () => {
    const classify = vi.fn(expectForbidden);
    const { events, onFinish, wire } = await runTurn({ classifyToolFailure: classify });
    expect(classify).toHaveBeenCalledWith({ toolName: 'list_tasks', status: 403, body: forbidden.data });
    expect(events[0]).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 0,
      tools: [{ toolId: LIST_TASKS_ID, calls: 1, errors: 0 }],
    });
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ expectedToolFailureCount: 1 }));
    expect(wire).toContain('"expectedFailure":true');
  });

  it('sends no new field to the Platform', async () => {
    const plain = await runTurn({});
    const classified = await runTurn({ classifyToolFailure: expectForbidden });
    const shapeKeys = Object.keys(TechnicalRuntimeEventV2Schema.shape).sort();
    for (const event of [plain.events[0]!, classified.events[0]!]) {
      expect(TechnicalRuntimeEventV2Schema.safeParse(event).success).toBe(true);
      expect(Object.keys(event).every((key) => shapeKeys.includes(key))).toBe(true);
      const serialized = JSON.stringify(event);
      for (const content of ['expected', 'NO_ROLE', 'Forbidden', 'Müller']) {
        expect(serialized).not.toContain(content);
      }
    }
    expect(Object.keys(classified.events[0]!).sort()).toEqual(Object.keys(plain.events[0]!).sort());
    expect(Object.keys(classified.events[0]!.tools[0]!).sort()).toEqual(['calls', 'errors', 'toolId']);
  });

  it('does not let an expected failure exhaust maxConsecutiveErrors', async () => {
    const limits = { ...localLimits, maxConsecutiveErrors: 1 };
    const steps = [() => toolStep('call-1'), () => toolStep('call-2'), () => textStep()];

    const plain = await runTurn({ managedRuntime: managedRuntime(limits), steps });
    expect(plain.model.doStreamCalls[1]!.tools ?? []).toHaveLength(0);
    expect(plain.wire).toContain('Stopped at runtime budget: maxConsecutiveErrors.');

    const classified = await runTurn({ managedRuntime: managedRuntime(limits), steps, classifyToolFailure: expectForbidden });
    expect(classified.model.doStreamCalls[1]!.tools ?? []).not.toHaveLength(0);
    expect(classified.wire).not.toContain('maxConsecutiveErrors');
    expect(classified.events[0]).toMatchObject({ toolCallCount: 2, toolErrorCount: 0 });
    expect(classified.onFinish).toHaveBeenCalledWith(expect.objectContaining({ expectedToolFailureCount: 2 }));
  });

  it('only affects metrics on the legacy path without managedRuntime', async () => {
    const { events } = await runTurn({ managedRuntime: undefined, classifyToolFailure: expectForbidden });
    expect(events[0]).toMatchObject({ toolCallCount: 1, toolErrorCount: 0 });
  });

  it('runs the error body through the PII shield', async () => {
    const detector: PiiDetector = {
      detect: (text) => {
        const start = text.indexOf(NAME);
        return start === -1 ? [] : [{ type: 'person', start, end: start + NAME.length, score: 1, text: NAME }];
      },
    };
    const { model, wire } = await runTurn({
      piiShield: createPiiShield({ locale: 'de', detector }),
      classifyToolFailure: expectForbidden,
    });
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('NO_ROLE');
    expect(prompt).toContain('403');
    expect(prompt).not.toContain('Müller');
    expect(wire).not.toContain('Müller');
  });
});

describe('classifyToolFailure in a direct command', () => {
  const listCommand = formatChatCommandMessage({
    commandId: 'tasks.list', tool: 'tasks.list', args: { query: 'Release' }, label: '/Search tasks',
  });
  const tools = {
    tasks_list: endpointToolToTool(defineEndpointTool({
      id: 'tasks.list',
      toolName: 'tasks_list',
      description: 'List tasks.',
      method: 'GET',
      path: '/api/tasks',
      inputSchema: z.object({ query: z.string() }).strict(),
    })),
  };

  async function runCommand(classifyToolFailure?: ToolFailureClassifier) {
    const { sink, events } = commandSink();
    const handler = createAiChatHandler({
      tools,
      model: scriptedModel([() => textStep()]),
      systemPrompt: 'Assistant',
      metrics: sink,
      endpointCaller: () => async () => forbidden,
      ...(classifyToolFailure ? { classifyToolFailure } : {}),
    });
    const output = await streamChunks(await handler(new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: listCommand }] }] }),
    })));
    return { output, events };
  }

  it('counts the failure as an error by default and not when expected', async () => {
    const plain = await runCommand();
    expect(plain.output.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({
      output: { success: false, error: 'Forbidden', status: 403, body: forbidden.data },
    });
    expect(plain.events[0]).toMatchObject({ toolCallCount: 1, toolErrorCount: 1 });

    const classified = await runCommand(expectForbidden);
    expect(classified.output.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({
      output: { success: false, status: 403, expectedFailure: true },
    });
    expect(classified.events[0]).toMatchObject({ toolCallCount: 1, toolErrorCount: 0 });
  });
});
