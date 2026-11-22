import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiChatHandlerConfig } from '../types.js';
import {
  agentRevision, ARCHIVE_TASK_ID, collectingSink, LIST_TASKS_ID, localLimits, manifestRevision, policyRevision, principal, streamChunks,
} from './command-fixtures.js';

type Part = Record<string, unknown>;
const NOTICE_ID = 'glirastes-stop-notice';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const text = (id: string, delta: string): Part[] => [
  { type: 'text-start', id }, { type: 'text-delta', id, delta }, { type: 'text-end', id },
];
const call = (id: string, toolName: string, input: unknown): Part => ({
  type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input),
});
const plan = (id: string, done: number): Part => call(id, 'update_plan', {
  items: ['Aufträge prüfen', 'Team prüfen', 'Material prüfen'].map((title, index) => ({
    title, status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
  })),
});

function scriptedModel(steps: Part[][]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = steps[Math.min(index++, steps.length - 1)]!;
      const calls = parts.some((part) => part.type === 'tool-call');
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...parts,
          { type: 'finish', finishReason: { unified: calls ? 'tool-calls' : 'stop', raw: undefined }, usage },
        ] as never),
      };
    },
  });
}

function registry(archive = vi.fn(async (input: unknown) => ({ success: true, archived: input })),
  list = vi.fn(async () => ({ success: true, tasks: [] }))) {
  const tools: ToolRegistry = {
    tasks_list: defineTool({
      id: 'tasks.list', description: 'List tasks.', method: 'GET',
      inputSchema: z.object({ query: z.string() }).strict(), execute: list,
    }),
    tasks_archive: defineTool({
      id: 'tasks.archive', description: 'Archive a task.', method: 'POST',
      inputSchema: z.object({ id: z.string() }).strict(), execute: archive,
    }),
  };
  return { tools, archive, list };
}

const userMessage = (id: string, words: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: words }] });

async function run(options: {
  steps: Part[][];
  messages?: UIMessage[];
  body?: Record<string, unknown>;
  config?: Partial<AiChatHandlerConfig>;
  tools?: ReturnType<typeof registry>;
}) {
  const model = scriptedModel(options.steps);
  const onFinish = vi.fn();
  const tools = options.tools ?? registry();
  const handler = createAiChatHandler({
    tools: tools.tools,
    model,
    systemPrompt: 'Assistant',
    planning: {},
    maxSteps: 3,
    onFinish,
    onError: () => undefined,
    ...options.config,
  });
  const messages = options.messages ?? [userMessage('u1', 'Prüfe Aufträge, Team und Material')];
  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, ...options.body }),
  }));
  const chunks = response.ok ? await streamChunks(response) : [];
  return { response, chunks, model, onFinish, messages, tools };
}

const noticeOf = (chunks: Part[]) => chunks
  .filter((chunk) => chunk.type === 'text-delta' && chunk.id === NOTICE_ID)
  .map((chunk) => chunk.delta as string);

/** The assistant message the browser keeps (data parts included). */
async function assistantMessage(chunks: Part[], id = 'a1'): Promise<UIMessage> {
  const stream = convertArrayToReadableStream(chunks as UIMessageChunk[]);
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: false })) last = message;
  return { ...last!, id };
}

/** Three steps: plan, read, plan update; the fourth (never run) would read again. */
const stoppedSteps = (run = ''): Part[][] => [
  [plan(`p1${run}`, 0)],
  [call(`c1${run}`, 'tasks_list', { query: 'dringend' })],
  [plan(`p2${run}`, 1)],
  text('a', 'Should not run.'),
];

describe('the stop notice of a turn stopped at a limit', () => {
  it('says what was done, what is open (the unchecked plan items) and how to continue', async () => {
    const turn = await run({ steps: stoppedSteps() });

    expect(turn.model.doStreamCalls).toHaveLength(3);
    const [notice] = noticeOf(turn.chunks);
    expect(notice).toBe([
      'I could not finish this request: the step limit for this request was reached (3 steps).',
      'Done so far: tasks_list.',
      'Still open: Team prüfen, Material prüfen.',
      'Choose “Continue” or write “continue” to go on with the open steps.',
    ].join('\n\n'));
  });

  it('names the tools by their labels and says the question is open without a plan, in German', async () => {
    const turn = await run({
      steps: [[call('c1', 'tasks_list', { query: 'a' })], [call('c2', 'tasks_list', { query: 'b' })], [call('c3', 'tasks_archive', { id: 't1' })]],
      config: { locale: 'de-DE' },
    });

    const [notice] = noticeOf(turn.chunks);
    expect(notice).toContain('Erledigt: tasks_list, tasks_archive.');
    expect(notice).toContain('Offen: Deine Frage ist noch nicht beantwortet.');
    expect(notice).toContain('Wähle „Weitermachen“ oder schreib „weiter“');
  });

  it('writes a continuable data-budget-stop part right before the notice', async () => {
    const turn = await run({ steps: stoppedSteps() });

    const stopAt = turn.chunks.findIndex((chunk) => chunk.type === 'data-budget-stop');
    const noticeAt = turn.chunks.findIndex((chunk) => chunk.type === 'text-start' && chunk.id === NOTICE_ID);
    expect(stopAt).toBeGreaterThan(-1);
    expect(noticeAt).toBe(stopAt + 1);
    expect(turn.chunks[stopAt]).toMatchObject({ data: { v: 1, continuable: true } });
  });

  it('writes no stop part for a turn that answers', async () => {
    const turn = await run({ steps: [text('a', 'Fertig.')] });
    expect(turn.chunks.some((chunk) => chunk.type === 'data-budget-stop')).toBe(false);
  });
});

describe('continuing a stopped turn', () => {
  async function stopped(steps: Part[][] = stoppedSteps(), tools = registry()) {
    const first = await run({ steps, tools });
    const assistant = await assistantMessage(first.chunks);
    return { messages: [...first.messages, assistant], tools };
  }

  it('runs the model again with an instruction listing the calls that ran and a fresh step budget', async () => {
    const { messages } = await stopped();
    const next = await run({
      steps: [[call('c4', 'tasks_list', { query: 'team' })], [call('c5', 'tasks_list', { query: 'material' })], text('b', 'Alles geprüft.')],
      messages,
      body: { glirastesContinuation: 'budget' },
    });

    expect(next.response.status).toBe(200);
    expect(next.model.doStreamCalls).toHaveLength(3);
    const prompt = next.model.doStreamCalls[0]!.prompt;
    const instruction = prompt.at(-1)!;
    expect(instruction.role).toBe('user');
    const words = JSON.stringify(instruction.content);
    expect(words).toContain('These tool calls already ran in it: tasks_list. Their results are above.');
    expect(words).toContain('Do only the steps that are still open');
    expect(noticeOf(next.chunks)).toEqual([]);
    expect(next.onFinish.mock.calls[0]![0]).toMatchObject({ continuation: 'budget', wasTruncated: false });
  });

  it('never runs a write call of the stopped turn again, but runs other calls', async () => {
    const tools = registry();
    const { messages } = await stopped([
      [call('c1', 'tasks_archive', { id: 't1' })],
      [call('c2', 'tasks_list', { query: 'x' })],
      [call('c3', 'tasks_list', { query: 'y' })],
    ], tools);
    expect(tools.archive).toHaveBeenCalledTimes(1);

    const next = await run({
      steps: [
        [call('d1', 'tasks_archive', { id: 't1' }), call('d2', 'tasks_archive', { id: 't2' }), call('d3', 'tasks_list', { query: 'x' })],
        text('b', 'Fertig.'),
      ],
      messages,
      body: { glirastesContinuation: 'budget' },
      tools,
    });

    expect(tools.archive).toHaveBeenCalledTimes(2);
    expect(tools.archive.mock.calls[1]![0]).toEqual({ id: 't2' });
    expect(tools.list).toHaveBeenCalledTimes(3);
    const refused = next.chunks.find((chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'd1');
    expect(refused).toMatchObject({ output: { success: false, error: expect.stringContaining('Not run again') } });
  });

  it('refuses the field without a continuable stop at the end of the history', async () => {
    const plain = await run({ steps: [text('a', 'x')], body: { glirastesContinuation: 'budget' } });
    expect(plain.response.status).toBe(400);
    expect(plain.model.doStreamCalls).toHaveLength(0);

    const { messages } = await stopped();
    const unknown = await run({ steps: [text('a', 'x')], messages, body: { glirastesContinuation: 'other' } });
    expect(unknown.response.status).toBe(400);
  });

  const continuedNotice = (messages: UIMessage[]) => messages.at(-1)!.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : [])).at(-1);

  it('stops offering continuation after three continuations of one turn', async () => {
    let { messages } = await stopped();
    let round = 0;
    const stopsFor = async () => {
      round += 1;
      const next = await run({ steps: stoppedSteps(`-${round}`), messages, body: { glirastesContinuation: 'budget' } });
      expect(next.response.status, JSON.stringify(messages.at(-1)!.parts.map((part) => part.type))).toBe(200);
      const continued = await assistantMessage(next.chunks, 'a1');
      // The continuation streams into the same assistant message.
      messages = [...messages.slice(0, -1), { ...continued, parts: [...messages.at(-1)!.parts, ...continued.parts] }];
      return next.chunks.find((chunk) => chunk.type === 'data-budget-stop')?.data as Part;
    };
    expect(await stopsFor()).toMatchObject({ continuable: true });
    expect(await stopsFor()).toMatchObject({ continuable: true });
    const last = await stopsFor();
    expect(last).toMatchObject({ continuable: false });
    // The last stop offers only the typed hint, and the server refuses another continuation.
    expect(continuedNotice(messages)).toContain('Write “continue” to go on with the open steps.');
    const refused = await run({ steps: [text('a', 'x')], messages, body: { glirastesContinuation: 'budget' } });
    expect(refused.response.status).toBe(400);
  });

  it('reports a managed continuation as a finished turn to the metrics (the Platform contract stays as it is)', async () => {
    const managed = (sink: ReturnType<typeof collectingSink>['sink']): Partial<AiChatHandlerConfig> => ({
      metrics: sink,
      approvalSecret: 'budget-continuation-secret-32-chars!!',
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(),
          localLimits: { ...localLimits, maxModelSteps: 2 },
        }),
        loadRevocations: async () => [],
      },
      maxSteps: undefined,
    });
    const managedTools = {
      tools: {
        tasks_list: defineTool({
          id: LIST_TASKS_ID, description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(),
          execute: async () => ({ success: true, tasks: [] }),
        }),
      },
    } as unknown as ReturnType<typeof registry>;
    const first = collectingSink();
    const stoppedTurn = await run({
      steps: [[call('c1', 'tasks_list', { query: 'a' })], [call('c2', 'tasks_list', { query: 'b' })]],
      config: managed(first.sink), tools: managedTools,
    });
    expect(noticeOf(stoppedTurn.chunks)).toHaveLength(1);
    const second = collectingSink();
    const next = await run({
      steps: [text('b', 'Fertig.')],
      messages: [...stoppedTurn.messages, await assistantMessage(stoppedTurn.chunks)],
      body: { glirastesContinuation: 'budget' },
      config: managed(second.sink), tools: managedTools,
    });
    expect(next.response.status).toBe(200);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ eventType: 'turn.finished', status: 'completed' });
    expect(JSON.stringify(second.events)).not.toContain('budget');
  });

  it('answers a repeated approval-requiring write of a managed turn without asking for approval or running it', async () => {
    const archive = vi.fn(async () => ({ success: true }));
    const list = vi.fn(async () => ({ success: true, tasks: [] }));
    const tools = {
      tools: {
        tasks_list: defineTool({
          id: LIST_TASKS_ID, description: 'List tasks.', inputSchema: z.object({ query: z.string() }).strict(), execute: list,
        }),
        tasks_archive: defineTool({
          id: ARCHIVE_TASK_ID, description: 'Archive a task.', inputSchema: z.object({ id: z.string() }).strict(), execute: archive,
        }),
      },
    } as unknown as ReturnType<typeof registry>;
    const stoppedAssistant = {
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'tool-tasks_archive', toolCallId: 'c1', state: 'output-available', input: { id: 't1' }, output: { success: true } },
        { type: 'step-start' },
        { type: 'tool-tasks_list', toolCallId: 'c2', state: 'output-available', input: { query: 'a' }, output: { success: true, tasks: [] } },
        { type: 'data-budget-stop', data: { v: 1, continuable: true } },
        { type: 'text', text: 'I could not finish this request.' },
      ],
    } as unknown as UIMessage;
    const next = await run({
      steps: [
        [call('d1', 'tasks_archive', { id: 't1' }), call('d2', 'tasks_list', { query: 'a' })],
        text('b', 'Fertig.'),
      ],
      messages: [userMessage('u1', 'Archiviere t1 und liste'), stoppedAssistant],
      body: { glirastesContinuation: 'budget' },
      tools,
      config: {
        maxSteps: undefined,
        approvalSecret: 'budget-continuation-secret-32-chars!!',
        managedRuntime: {
          resolvePrincipal: async () => principal(),
          resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
            turnId, agentRevision, manifestRevision, policyRevision: policyRevision(), principal: principal(), localLimits,
          }),
          loadRevocations: async () => [],
        },
      },
    });

    expect(next.response.status).toBe(200);
    expect(next.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(next.chunks.find((chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'd1'))
      .toMatchObject({ output: { success: false, error: expect.stringContaining('Not run again') } });
  });
});
