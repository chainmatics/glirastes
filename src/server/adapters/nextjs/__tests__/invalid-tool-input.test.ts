import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ExecutionBudget } from '../../../../contracts/index.js';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import { ToolInputValidationError } from '../../../../runtime/tool-input-error.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type SchemaLike, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { prepareModelMessages } from '../prepare-model-messages.js';
import { INVALID_TOOL_INPUT_HISTORY_TEXT, INVALID_TOOL_INPUT_TEXT } from '../stream-error-text.js';
import {
  agentRevision, collectingSink, localLimits, manifestRevision, policyRevision, principal, streamChunks,
} from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const callStep = (input: unknown, callId = 'call-1') => () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: callId, toolName: 'tasks_list', input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
] as never);
const textStep = () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Final answer.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
] as never);

const VALUE = 'Abend-Promos';
const INSTRUCTION = 'Correct the arguments and call the tool again now, in this turn. If a field expects an id or uuid and you only have a name, first find the id with a list or search tool, then call this tool again; do not ask the user for an id.';
const BROWSER_TEXT = 'The assistant sent invalid input for this tool; it was told what to correct.';

const zodInput = z.object({ playlistId: z.string().uuid(), kind: z.enum(['a', 'b']) }).strict();
const jsonInput = createJsonSchemaLike({
  type: 'object',
  additionalProperties: false,
  required: ['playlistId', 'kind'],
  properties: { playlistId: { type: 'string', format: 'uuid' }, kind: { enum: ['a', 'b'] } },
});

async function runTurn(options: {
  managed: boolean;
  steps: Array<() => ReadableStream>;
  inputSchema?: SchemaLike | z.ZodType;
  limits?: Partial<ExecutionBudget>;
}) {
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: options.steps[Math.min(call++, options.steps.length - 1)]!() }),
  });
  const list = vi.fn(async () => ({ tasks: [] }));
  const registry: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list', description: 'List tasks.', inputSchema: (options.inputSchema ?? zodInput) as never, execute: list,
    }),
  };
  const { sink, events } = collectingSink();
  const onError = vi.fn();
  const handler = createAiChatHandler({
    tools: registry,
    model,
    systemPrompt: 'Assistant',
    onError,
    resultHandles: false,
    approvalSecret: 'invalid-input-test-secret-32-chars!',
    ...(options.managed
      ? {
          metrics: sink,
          managedRuntime: {
            resolvePrincipal: async () => principal(),
            resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
              turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
              localLimits: { ...localLimits, ...options.limits },
            }),
            loadRevocations: async () => [],
          },
        }
      : {}),
  });
  const chunks = await streamChunks(await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
  })));
  return { chunks, model, list, onError, events };
}

function toolErrorsSentToModel(model: MockLanguageModelV3, call = 1): string[] {
  return (model.doStreamCalls[call]?.prompt ?? [])
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Array<{ output: { type: string; value: unknown } }>)
    .filter((result) => result.output.type === 'error-text')
    .map((result) => String(result.output.value));
}

describe.each([
  ['non-managed', false],
  ['managed', true],
] as const)('a model tool call with invalid input (%s)', (_label, managed) => {
  it.each([
    ['a Zod schema', zodInput, 'kind: expected one of "a", "b"'],
    ['a JSON schema', jsonInput, 'kind: required'],
  ] as const)('tells the model which fields and what they expect, without the value (%s)', async (_schema, inputSchema, kindText) => {
    const turn = await runTurn({ managed, inputSchema, steps: [callStep({ playlistId: VALUE }), textStep] });

    const [text] = toolErrorsSentToModel(turn.model);
    expect(text).toContain('Invalid input for tool tasks_list: ');
    expect(text).toContain('playlistId: expected format uuid');
    expect(text).toContain(kindText);
    expect(text).toContain(INSTRUCTION);
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain('Type validation failed');
    expect(turn.list).not.toHaveBeenCalled();
  });

  it('names at most five issues and counts the rest', async () => {
    const wide = z.object(Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}`, z.string().uuid()]),
    )).strict();
    const input = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, `${VALUE}-${'x'.repeat(200)}`]));
    const turn = await runTurn({ managed, inputSchema: wide, steps: [callStep(input), textStep] });

    const [text] = toolErrorsSentToModel(turn.model);
    expect(text!.match(/expected format uuid/g)).toHaveLength(5);
    expect(text).toContain('7 more.');
    expect(text).not.toContain(VALUE);
    expect(text!.length).toBeLessThan(600);
  });

  it('shows the chat its own text, reports it once without the value, and continues the turn', async () => {
    const turn = await runTurn({ managed, steps: [callStep({ playlistId: VALUE }), textStep] });

    expect(turn.chunks.filter((chunk) => chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error')
      .map((chunk) => [chunk.type, chunk.errorText])).toEqual([
      ['tool-input-error', BROWSER_TEXT],
      ['tool-output-error', BROWSER_TEXT],
    ]);
    expect(JSON.stringify(turn.chunks)).not.toContain('AI request failed');
    expect(JSON.stringify(turn.chunks)).toContain('Final answer.');
    expect(turn.model.doStreamCalls).toHaveLength(2);

    expect(turn.onError).toHaveBeenCalledTimes(1);
    const [error, , info] = turn.onError.mock.calls[0]!;
    expect(info).toEqual({ source: 'tool-call', kind: 'invalid-input' });
    expect(error).toBeInstanceOf(ToolInputValidationError);
    expect(error).toMatchObject({
      toolName: 'tasks_list',
      issues: expect.arrayContaining([{ path: 'playlistId', expected: 'expected format uuid' }]),
    });
    expect(JSON.stringify(error)).not.toContain(VALUE);
    expect(String((error as Error).message)).not.toContain(VALUE);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('an invalid tool call in a later turn', () => {
  it('reads as an instruction for the model, not as the chat text the browser kept', async () => {
    expect(BROWSER_TEXT).toBe(INVALID_TOOL_INPUT_TEXT);
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show the playlist' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'step-start' },
          { type: 'tool-tasks_list', toolCallId: 'call-1', state: 'output-error', rawInput: { playlistId: VALUE }, errorText: BROWSER_TEXT },
          { type: 'text', text: 'Which playlist id?' },
        ],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'The evening one' }] },
    ];
    const prompt = await prepareModelMessages(history as never) as Array<{ role: string; content: unknown }>;
    const results = prompt.filter((message) => message.role === 'tool')
      .flatMap((message) => message.content as Array<{ output: { type: string; value: unknown } }>);
    expect(results.map((result) => result.output)).toEqual([{ type: 'error-text', value: INVALID_TOOL_INPUT_HISTORY_TEXT }]);
    expect(JSON.stringify(prompt)).not.toContain(BROWSER_TEXT);
    expect(INVALID_TOOL_INPUT_HISTORY_TEXT).not.toContain(VALUE);
  });

  it('keeps every other tool error text as the browser holds it', async () => {
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'step-start' },
          { type: 'tool-tasks_list', toolCallId: 'call-1', state: 'output-error', input: {}, errorText: 'AI request failed' },
        ],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Again' }] },
    ];
    expect(JSON.stringify(await prepareModelMessages(history as never))).toContain('AI request failed');
  });
});

describe('budgets with invalid tool input', () => {
  it('count it like before: not against maxToolCalls, as a call and an error in the metric event', async () => {
    const turn = await runTurn({
      managed: true,
      limits: { maxToolCalls: 1 },
      steps: [callStep({ playlistId: VALUE }), callStep({ playlistId: '019fb710-0000-7000-8000-000000000099', kind: 'a' }, 'call-2'), textStep],
    });

    expect(turn.list).toHaveBeenCalledTimes(1);
    expect(turn.events[0]).toMatchObject({ toolCallCount: 2, toolErrorCount: 1 });
  });
});
