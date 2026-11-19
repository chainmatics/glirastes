import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import { UI_OUTCOME_MODEL_TEXTS, UI_OUTCOME_SYSTEM_NOTE } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  FIXTURE_TENANT_ID,
  pythonReady,
  removeCopiedApps,
  VUE_APP,
  VUE_GENERATED_MODULE,
  type BootedFastapiApp,
} from './support/tool-runtime.js';

/**
 * Model-free acceptance of the outcome protocol for UI actions on the
 * Vue+FastAPI fixture: the generated navigation tool (`ui_navigate`) through
 * the fixture's own chat runtime (runtime/chat.mjs). With the request flag
 * the result waits for the browser and the request ends after that step; the
 * continuation reads only the fixed text of the reported code; without the
 * flag (an older or a custom client) the hand-off has no marker and the
 * model writes on in the same request.
 */
const PYTHON_READY = pythonReady();
const FLAG = { glirastesUiOutcomes: 1 };
const ASK = 'Open the overview';

type Json = Record<string, unknown>;

let root: string;
let app: BootedFastapiApp;

beforeAll(async () => {
  if (!PYTHON_READY) return;
  assertBuiltSdk();
  root = await copyApp(VUE_APP, '.second-acceptance-ui-outcomes-');
  await runToolsPipeline({ root, mode: 'write' });
  app = await bootFastapiApp(root);
}, 240_000);
afterAll(async () => {
  await closeFastapiApps();
  await removeCopiedApps();
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The user asks to open the overview: navigate there; anything else (a tool result, a continuation): answer with text. */
function navigatingModel() {
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const last = prompt.at(-1);
    const asked = last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === ASK);
    const chunks = asked
      ? [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'ui_navigate', input: JSON.stringify({ destination: '/overview' }) },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
      ]
      : [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: 'Opened the overview.' },
        { type: 'text-end' as const, id: 'answer' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
      ];
    return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
  } });
}

/** The chunks of a UI message stream (`data: {...}` lines). */
function chunksOf(stream: string): Json[] {
  return stream.split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Json);
}

/** One POST to the fixture's chat runtime with a scripted model; the model is returned for its calls. */
async function chat(body: Json): Promise<{ chunks: Json[]; model: MockLanguageModelV3 }> {
  const { createChatRuntime } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href) as {
    createChatRuntime(options: Json): { server: Server };
  };
  const model = navigatingModel();
  const runtime = createChatRuntime({ apiOrigin: () => app.apiOrigin, model: () => model, tenantId: FIXTURE_TENANT_ID });
  await new Promise<void>((listening) => runtime.server.listen(0, '127.0.0.1', listening));
  try {
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return { chunks: chunksOf(await response.text()), model };
  } finally {
    await new Promise<void>((closed) => runtime.server.close(() => closed()));
  }
}

const userMessage = () => ({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: ASK }] });

function toolOutputs(chunks: Json[]): Array<{ toolCallId: string; output: Json }> {
  return chunks.filter((chunk) => chunk.type === 'tool-output-available')
    .map((chunk) => ({ toolCallId: chunk.toolCallId as string, output: chunk.output as Json }));
}

const prompt = (model: MockLanguageModelV3, index = 0) => JSON.stringify(model.doStreamCalls[index]!.prompt);
const hasText = (chunks: Json[]) => chunks.some((chunk) => chunk.type === 'text-delta');

describe.skipIf(!PYTHON_READY)('second acceptance fixture: outcome protocol of the generated navigation tool', () => {
  it('generates ui_navigate with the Glirastes navigation action', async () => {
    const generated = await import(pathToFileURL(join(root, VUE_GENERATED_MODULE)).href) as {
      toolCatalog: ReadonlyArray<{ modelName: string }>;
    };
    expect(generated.toolCatalog.map((tool) => tool.modelName)).toContain('ui_navigate');
    const turn = app.turn({ authorization: `Bearer ${app.token}` });
    expect(await turn.execute('ui_navigate', { destination: '/overview' })).toMatchObject({
      handedOff: true,
      uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } },
    });
  });

  it('with the flag: marks the result awaitsOutcome, ends the request after the step, calls the model once', async () => {
    const { chunks, model } = await chat({ messages: [userMessage()], ...FLAG });
    const [result] = toolOutputs(chunks);
    expect(toolOutputs(chunks)).toHaveLength(1);
    expect(result!.output).toMatchObject({
      handedOff: true,
      awaitsOutcome: true,
      uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } },
    });
    expect(result!.output).not.toHaveProperty('success');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(prompt(model)).toContain(UI_OUTCOME_SYSTEM_NOTE);
    expect(hasText(chunks)).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  }, 60_000);

  it.each(['ok', 'unavailable'] as const)('continues after the reported outcome %s with its fixed text only', async (code) => {
    const user = userMessage();
    const first = await chat({ messages: [user], ...FLAG });
    const [result] = toolOutputs(first.chunks);
    const message = result!.output.message as string;
    expect(typeof message).toBe('string');
    const history = [user, {
      id: randomUUID(),
      role: 'assistant',
      parts: [{ type: 'step-start' }, {
        type: 'tool-ui_navigate',
        toolCallId: result!.toolCallId,
        state: 'output-available',
        input: { destination: '/overview' },
        output: { ...result!.output, outcome: { v: 1, code } },
      }],
    }];
    const { chunks, model } = await chat({ messages: history, ...FLAG });
    expect(model.doStreamCalls).toHaveLength(1);
    const sent = prompt(model);
    expect(sent).toContain(UI_OUTCOME_MODEL_TEXTS[code]);
    expect(sent).not.toContain(message);
    expect(sent).not.toContain('awaitsOutcome');
    expect(sent.includes('"success":true')).toBe(code === 'ok');
    expect(sent.includes('"success":false')).toBe(code === 'unavailable');
    expect(hasText(chunks)).toBe(true);
    // The continuation runs nothing again.
    expect(toolOutputs(chunks)).toEqual([]);
  }, 60_000);

  it('without the flag (an older client, a custom client on /server/http): hand-off without marker, the model writes on', async () => {
    const { chunks, model } = await chat({ messages: [userMessage()] });
    const [result] = toolOutputs(chunks);
    expect(Object.keys(result!.output).sort()).toEqual(['handedOff', 'message', 'uiAction']);
    expect(result!.output).toMatchObject({ handedOff: true, uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } } });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(prompt(model)).not.toContain(UI_OUTCOME_SYSTEM_NOTE);
    expect(hasText(chunks)).toBe(true);
  }, 60_000);
});
