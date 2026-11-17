import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ExecutionBudget } from '../../../../contracts/index.js';
import { createManagedTurnGuard } from '../../../../runtime/managed-turn.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { createTurnResults } from '../result-handles.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  agentRevision, collectingSink, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal, streamChunks,
} from './command-fixtures.js';

const INTERIM = 'I\'ll keep reading the variants. One moment.';
const NOTICE_ID = 'glirastes-stop-notice';
const notice = (reason: string) => `I had to stop here: ${reason}. The answer above may be incomplete.`;
const noticeWithoutAnswer = (reason: string) => `I could not finish this request: ${reason}.`;

const usage = (input: number, output = 10) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** 45 variants of ~3,000 characters: the list is an overview, `read_result` pages of up to 16,000 characters. */
const variants = () => ({
  success: true,
  variants: Array.from({ length: 45 }, (_, index) => ({ id: `v${index}`, name: `Variant ${index}`, body: `b${index}-${'x'.repeat(3_000)}` })),
});

type Part = Record<string, unknown>;
const text = (id: string, delta: string): Part[] => [
  { type: 'text-start', id }, { type: 'text-delta', id, delta }, { type: 'text-end', id },
];
const toolCall = (id: string, toolName: string, input: unknown): Part => ({
  type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input),
});

interface Step {
  parts: (prompt: string) => Part[];
  input?: number;
  output?: number;
  delayMs?: number;
  fail?: boolean;
}

/** The pilot: list, then an interim sentence and the next `read_result` page per step. */
const listStep: Step = { parts: () => [toolCall('call-1', 'tasks_list', { query: 'q' })] };
const pageStep = (page: number): Step => ({
  parts: (prompt) => [
    ...text(`t${page}`, INTERIM),
    toolCall(`read-${page}`, 'read_result', { resultId: /r[ow]_[0-9a-z]{8}/.exec(prompt)?.[0], offset: page * 10, limit: 10 }),
  ],
});
const answerStep = (answer: string): Step => ({ parts: () => (answer ? text('a', answer) : []) });

function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.fail) throw new Error('provider unavailable');
      const parts = step.parts(JSON.stringify(options.prompt));
      const calls = parts.some((part) => part.type === 'tool-call');
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...parts,
          { type: 'finish', finishReason: { unified: calls ? 'tool-calls' : 'stop', raw: undefined }, usage: usage(step.input ?? 1, step.output) },
        ] as never),
      };
    },
  });
}

function registry(list?: () => Promise<unknown>): ToolRegistry {
  return {
    tasks_list: defineTool({
      id: LIST_TASKS_ID, description: 'List variants.', inputSchema: z.object({ query: z.string() }).strict(),
      execute: list ?? (async () => variants()),
    }),
  };
}

const userMessage = (id: string, words: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: words }] });

async function runTurn(options: {
  steps: Step[];
  limits?: Partial<ExecutionBudget>;
  managed?: boolean;
  config?: Partial<AiChatHandlerConfig>;
  messages?: UIMessage[];
  list?: () => Promise<unknown>;
}) {
  const model = scriptedModel(options.steps);
  const { sink, events } = collectingSink();
  const onFinish = vi.fn();
  const handler = createAiChatHandler({
    tools: registry(options.list),
    model,
    systemPrompt: 'Assistant',
    approvalSecret: 'budget-stop-test-secret-32-chars!!!!',
    onFinish,
    onError: () => undefined,
    ...(options.managed === false
      ? {}
      : {
          metrics: sink,
          managedRuntime: {
            resolvePrincipal: async () => principal(),
            resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
              turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
              localLimits: { ...localLimits, ...options.limits },
            }),
            loadRevocations: async () => [],
          },
        }),
    ...options.config,
  });
  const messages = options.messages ?? [userMessage('u1', 'List the variants')];
  const chunks = await streamChunks(await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  })));
  return { chunks, model, events, onFinish, messages };
}

/** The texts of the stop notice in the stream. */
const notices = (chunks: Part[]) => chunks
  .filter((chunk) => chunk.type === 'text-delta' && chunk.id === NOTICE_ID)
  .map((chunk) => chunk.delta);

/** The assistant message the browser keeps from the stream. */
async function assistantMessage(chunks: Part[]): Promise<UIMessage> {
  const stream = convertArrayToReadableStream(chunks.filter((chunk) => !String(chunk.type).startsWith('data-')) as UIMessageChunk[]);
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: false })) last = message;
  return { ...last!, id: 'a1' };
}

const textsOf = (message: UIMessage) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));

/** The text of the last prompt message (the summary instruction, when there is one). */
function lastPromptText(model: MockLanguageModelV3, call: number): string {
  const message = model.doStreamCalls[call]!.prompt.at(-1)!;
  return message.role === 'user'
    ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    : '';
}

describe('the pilot: paging through a result until the input token budget is used up', () => {
  const steps = (): Step[] => [
    { ...listStep, input: 2_000 },
    { ...pageStep(0), input: 6_000 },
    { ...pageStep(1), input: 9_000 },
    { ...pageStep(2), input: 11_000 },
    { ...pageStep(3), input: 13_000 },
    { ...answerStep('Should not run.'), input: 15_000 },
  ];

  it('ends with the closing notice after the interim sentence, without another model call', async () => {
    const turn = await runTurn({ steps: steps(), limits: { maxInputTokens: 40_000, maxModelSteps: 6, maxToolCalls: 8 } });

    // Five calls cost 41,000 input tokens; a sixth would cost 15,000 more.
    expect(turn.model.doStreamCalls).toHaveLength(5);
    const expected = notice('the limit for this request was reached (input tokens: 40,000)');
    expect(notices(turn.chunks)).toEqual([expected]);
    const message = await assistantMessage(turn.chunks);
    expect(textsOf(message).at(-1)).toBe(expected);
    expect(textsOf(message).at(-2)).toBe(INTERIM);
    expect(JSON.stringify(turn.chunks)).not.toContain('Should not run.');
    // Status, metrics and onFinish are unchanged.
    expect(turn.events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted' });
    expect(turn.onFinish.mock.calls[0]![0]).toMatchObject({ wasTruncated: true, finishReason: 'tool-calls' });
    expect(turn.chunks.find((chunk) => chunk.type === 'data-pipeline-state' && (chunk.data as Part).status === 'safety-stop'))
      .toMatchObject({ data: { message: 'Stopped at runtime budget: maxInputTokens.' } });
  });

  it('keeps the notice in the assistant message, so the next turn\'s model sees the answer was cut short', async () => {
    const first = await runTurn({ steps: steps(), limits: { maxInputTokens: 40_000, maxModelSteps: 6, maxToolCalls: 8 } });
    const assistant = await assistantMessage(first.chunks);

    const next = await runTurn({
      steps: [answerStep('Continuing.')],
      messages: [...first.messages, assistant, userMessage('u2', 'Continue')],
    });

    const prompt = JSON.stringify(next.model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('I had to stop here: the limit for this request was reached (input tokens: 40,000).');
    expect(notices(next.chunks)).toEqual([]);
  });
});

describe('a turn stopped at a limit that leaves no room for a model call', () => {
  it.each([
    ['output tokens', { maxOutputTokens: 100 }, { output: 150 }, 'the limit for this request was reached (output tokens: 100)'],
    ['cost', { maxEstimatedCostUsd: 0.5 }, { input: 1_000 }, 'the cost limit for this request was reached (0.5 USD)'],
  ] as const)('closes with the notice for %s', async (_label, limits, cost, reason) => {
    const turn = await runTurn({
      steps: [{ ...listStep, ...cost }, answerStep('Should not run.')],
      limits,
      config: { modelPricing: { version: 'test', models: { 'mock-model-id': { inputUsdPerMillion: 1_000, outputUsdPerMillion: 0 } } } },
    });

    expect(turn.model.doStreamCalls).toHaveLength(1);
    // Only tool calls were shown: there is no answer above to speak of.
    expect(notices(turn.chunks)).toEqual([noticeWithoutAnswer(reason)]);
    expect(turn.events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted' });
  });

  it('closes with the notice when the turn time limit aborts the model call', async () => {
    const turn = await runTurn({
      steps: [listStep, { ...answerStep('Too late.'), delayMs: 400 }],
      limits: { totalTimeoutMs: 150 },
    });

    expect(notices(turn.chunks)).toEqual([noticeWithoutAnswer('the time limit for this request was reached (150 ms)')]);
    // The notice comes before the abort, which ends the stream as before.
    expect(turn.chunks.at(-1)).toMatchObject({ type: 'abort' });
    expect(turn.chunks.at(-2)).toMatchObject({ type: 'text-end', id: NOTICE_ID });
    expect(turn.chunks.find((chunk) => chunk.type === 'data-pipeline-state' && (chunk.data as Part).status === 'aborted'))
      .toMatchObject({ data: { message: 'Stopped at runtime budget: totalTimeoutMs.' } });
    expect(turn.events[0]).toMatchObject({ status: 'safety-stop', errorCode: 'budget_exhausted' });
  });

  it('closes with the notice at the model step budget', async () => {
    const turn = await runTurn({
      steps: [listStep, pageStep(0), pageStep(1), answerStep('Should not run.')],
      limits: { maxModelSteps: 3 },
    });

    expect(turn.model.doStreamCalls).toHaveLength(3);
    expect(notices(turn.chunks)).toEqual([notice('the step limit for this request was reached (3 steps)')]);
  });
});

describe('a turn stopped at a tool limit, with the final summary call', () => {
  const toolLimit = { maxToolCalls: 2 };
  const steps = (summary: Step): Step[] => [listStep, pageStep(0), summary];

  it('tells the model to say it had to stop, what is finished, what is open and that the answer is incomplete', async () => {
    const turn = await runTurn({ steps: steps(answerStep('I had to stop; here is what I found.')), limits: toolLimit });

    expect(turn.model.doStreamCalls).toHaveLength(3);
    expect(turn.model.doStreamCalls[2]!.toolChoice).toEqual({ type: 'none' });
    const instruction = lastPromptText(turn.model, 2);
    expect(instruction).toContain('the limit of 2 tool calls per turn is reached (2 used)');
    expect(instruction).toContain('say plainly that you had to stop');
    expect(instruction).toContain('what is still open');
    expect(instruction).toContain('incomplete');
    // The instruction is for the call only, never part of the chat.
    expect(JSON.stringify(turn.chunks)).not.toContain('This turn has to end now');
  });

  it('adds no notice when the summary answers', async () => {
    const turn = await runTurn({ steps: steps(answerStep('I had to stop; here is what I found.')), limits: toolLimit });

    expect(notices(turn.chunks)).toEqual([]);
    expect(textsOf(await assistantMessage(turn.chunks)).at(-1)).toBe('I had to stop; here is what I found.');
  });

  it('closes with the notice when the summary says nothing', async () => {
    const turn = await runTurn({ steps: steps(answerStep('')), limits: toolLimit });

    expect(turn.model.doStreamCalls).toHaveLength(3);
    expect(notices(turn.chunks)).toEqual([notice('the limit for this request was reached (tool calls: 2)')]);
  });

  it('closes with the notice before the error when the summary call fails', async () => {
    const turn = await runTurn({ steps: steps({ parts: () => [], fail: true }), limits: toolLimit });

    expect(notices(turn.chunks)).toEqual([notice('the limit for this request was reached (tool calls: 2)')]);
    const noticeAt = turn.chunks.findIndex((chunk) => chunk.type === 'text-start' && chunk.id === NOTICE_ID);
    const errorAt = turn.chunks.findIndex((chunk) => chunk.type === 'error');
    expect(errorAt).toBeGreaterThan(noticeAt);
    const message = await assistantMessage(turn.chunks);
    expect(textsOf(message).at(-1)).toBe(notice('the limit for this request was reached (tool calls: 2)'));
  });
});

describe('the step cap without a managed runtime', () => {
  it('closes a turn stopped at maxSteps with the notice', async () => {
    const turn = await runTurn({
      managed: false,
      steps: [listStep, pageStep(0), answerStep('Should not run.')],
      config: { maxSteps: 2 },
    });

    expect(turn.model.doStreamCalls).toHaveLength(2);
    expect(notices(turn.chunks)).toEqual([notice('the step limit for this request was reached (2 steps)')]);
    expect(turn.onFinish.mock.calls[0]![0]).toMatchObject({ wasTruncated: true });
  });

  it('adds nothing to a turn that answers within its limits', async () => {
    for (const managed of [true, false]) {
      const turn = await runTurn({ managed, steps: [listStep, answerStep('Here are the variants.')], config: { maxSteps: 2 } });
      expect(notices(turn.chunks)).toEqual([]);
      expect(JSON.stringify(turn.chunks)).not.toContain('I had to stop here');
    }
  });
});

describe('the texts of the notice', () => {
  const pilot = (): Step[] => [{ ...listStep, input: 30_000 }, { ...pageStep(0), input: 12_000 }, answerStep('Should not run.')];

  it('come from the keyed table, which budgetStopTexts overrides', async () => {
    const turn = await runTurn({
      steps: pilot(),
      limits: { maxInputTokens: 40_000 },
      config: { budgetStopTexts: { closing: 'Stopped early: {reason}.', maxInputTokens: 'token limit {limit} reached' } },
    });

    expect(notices(turn.chunks)).toEqual(['Stopped early: token limit 40,000 reached.']);
  });

  it('are German for a German locale', async () => {
    const turn = await runTurn({ steps: pilot(), limits: { maxInputTokens: 40_000 }, config: { locale: 'de-DE' } });

    expect(notices(turn.chunks)).toEqual([
      'Ich musste hier aufhören: das Limit für diese Anfrage ist erreicht (Eingabe-Tokens: 40.000). '
        + 'Die Antwort oben ist möglicherweise unvollständig.',
    ]);
  });

  it('reject an unknown key or an empty text when the handler is created', () => {
    const create = (texts: unknown) => () => createAiChatHandler({
      tools: registry(), model: {}, systemPrompt: 'A', budgetStopTexts: texts as never,
    });
    expect(create({ maxTokens: 'x' })).toThrow('budgetStopTexts.maxTokens is not a text key');
    expect(create({ closing: ' ' })).toThrow('budgetStopTexts.closing must be a non-empty string');
  });
});

describe('read_result at the used-up budget', () => {
  it('names the reached limit and its use', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-1', agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
      localLimits: { ...localLimits, maxToolCalls: 1 },
    });
    const managedTurn = createManagedTurnGuard({ snapshot, resolvePrincipal: () => principal() });
    managedTurn.tracker.recordToolCall();
    const { tool } = createTurnResults({ limits: {}, managedTurn, resolvePrincipal: async () => principal() });

    const answer = await (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> })
      .execute({ resultId: 'ro_00000000' }, { toolCallId: 'read-1', messages: [] });

    expect(answer).toEqual({
      error: 'budget_exhausted',
      hint: 'Not read: the limit of 1 tool call per turn is reached (1 used). Do not read further in this turn; '
        + 'answer with what you have and tell the user that the answer is incomplete.',
    });
  });
});
