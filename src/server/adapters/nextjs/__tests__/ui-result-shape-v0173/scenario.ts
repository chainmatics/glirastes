/**
 * One UI tool turn per case, run against a glirastes SDK given as `sdk`:
 * the 0.17.3 package (`record.ts`, which wrote `golden-0.17.3.json`) or
 * this source tree (`ui-result-shape-v0173.test.ts`). Every request is sent
 * WITHOUT `glirastesUiOutcomes`, as a 0.17 browser sends it. Model-free: a
 * scripted model calls the case's tool, then answers with text.
 *
 * Imports nothing of the SDK, so both trees run exactly the same scenario.
 */

type Json = Record<string, unknown>;

/** The parts of an SDK the scenario needs (0.17.3 and later spell them alike). */
export interface ScenarioSdk {
  createAiChatHandler(config: Json): (request: Request) => Promise<Response>;
  uiActionToolToTool(definition: Json): unknown;
  uiToolToTool(tool: unknown): unknown;
  defineUiTool(definition: Json): unknown;
  z: {
    object(shape: Json): unknown;
    string(): { optional(): unknown };
    enum(values: [string, ...string[]]): { optional(): unknown };
  };
  MockLanguageModelV3: new (options: Json) => { doStreamCalls: Array<{ prompt: unknown }> };
  convertArrayToReadableStream(chunks: unknown[]): unknown;
}

export interface ScenarioCase {
  name: string;
  toolName: string;
  input: Json;
  /** `glirastesClientActions` of the request (the actions the open page offers). */
  clientActions?: string[];
}

export const CASES: ScenarioCase[] = [
  { name: 'generated navigation', toolName: 'ui_navigate', input: { destination: '/tasks' } },
  { name: 'generated filter', toolName: 'ui_filter_tasks', input: { status: 'open' } },
  { name: 'generated client action, offered by the open page', toolName: 'ui_refresh_tasks', input: {}, clientActions: ['tasks.refresh'] },
  {
    name: 'generated page-bound client action, handed off to its route',
    toolName: 'ui_archive_task',
    input: { taskId: 't1' },
    clientActions: ['tasks.refresh'],
  },
  { name: 'hand-written defineUiTool with a uiAction', toolName: 'ui_open_task', input: { taskId: 't1' } },
];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function registry(sdk: ScenarioSdk): Json {
  const { z } = sdk;
  return {
    ui_navigate: sdk.uiActionToolToTool({
      id: 'ui.navigate', toolName: 'ui_navigate', description: 'Open a page of the app.',
      inputSchema: z.object({ destination: z.string() }), needsApproval: false, action: { kind: 'navigate' },
    }),
    ui_filter_tasks: sdk.uiActionToolToTool({
      id: 'ui.filter.tasks', toolName: 'ui_filter_tasks', description: 'Filter the task list.',
      inputSchema: z.object({ status: z.enum(['open', 'done']).optional() }), needsApproval: false,
      action: { kind: 'filter', destination: '/tasks', keys: [{ key: 'status' }] },
    }),
    ui_refresh_tasks: sdk.uiActionToolToTool({
      id: 'ui.tasks.refresh', toolName: 'ui_refresh_tasks', description: 'Reload the task list.',
      inputSchema: z.object({}), needsApproval: false, action: { kind: 'client-action', actionId: 'tasks.refresh' },
    }),
    ui_archive_task: sdk.uiActionToolToTool({
      id: 'ui.tasks.archive', toolName: 'ui_archive_task', description: 'Archive a task on the task page.',
      inputSchema: z.object({ taskId: z.string() }), needsApproval: false,
      action: { kind: 'client-action', actionId: 'tasks.archive', route: '/tasks' },
    }),
    ui_open_task: sdk.uiToolToTool(sdk.defineUiTool({
      id: 'ui.open-task', toolName: 'ui_open_task', description: 'Open a task in a dialog.',
      inputSchema: z.object({ taskId: z.string() }),
      uiAction: { type: 'open-dialog', dialog: 'task', taskId: '$taskId' },
    })),
  };
}

function scriptedModel(sdk: ScenarioSdk, call: ScenarioCase) {
  let step = 0;
  return new sdk.MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      return {
        stream: sdk.convertArrayToReadableStream(step === 1
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: call.toolName, input: JSON.stringify(call.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]),
      };
    },
  });
}

/** What a case produced: the stream (random message id removed) and the tool results the model read. */
export interface CaseRecord {
  chunks: Json[];
  modelToolResults: unknown[];
}

/** Wall-clock fields of the step parts; their value is the only thing that differs between two runs. */
const CLOCK_FIELDS = new Set(['updatedAt', 'createdAt']);

function withoutClock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClock);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
    [key, CLOCK_FIELDS.has(key) && typeof entry === 'string' ? '<time>' : withoutClock(entry)]
  )));
}

async function chunksOf(response: Response): Promise<Json[]> {
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => withoutClock(JSON.parse(line.slice('data: '.length))) as Json)
    .map((chunk) => (chunk.type === 'start' ? { type: 'start' } : chunk));
}

export async function runCase(sdk: ScenarioSdk, call: ScenarioCase, config: Json = {}): Promise<CaseRecord> {
  const model = scriptedModel(sdk, call);
  const handler = sdk.createAiChatHandler({ tools: registry(sdk), systemPrompt: 'Assistant', model, ...config });
  const body: Json = {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Please do it' }] }],
    ...(call.clientActions ? { glirastesClientActions: call.clientActions } : {}),
  };
  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const chunks = await chunksOf(response);
  const second = model.doStreamCalls[1]?.prompt as Array<{ role: string; content: unknown }> | undefined;
  return { chunks, modelToolResults: (second ?? []).filter((message) => message.role === 'tool').map((message) => message.content) };
}

export async function runAll(sdk: ScenarioSdk, config: Json = {}): Promise<Record<string, CaseRecord>> {
  const records: Record<string, CaseRecord> = {};
  for (const call of CASES) records[call.name] = await runCase(sdk, call, config);
  return records;
}
