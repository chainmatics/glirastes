import { randomUUID } from 'node:crypto';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import {
  assertBuiltSdk,
  copyApp,
  EXAMPLES,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

/**
 * Model-free check of the outcome protocol on the Next reference app: the
 * native app plus the browser shell's chat route (`src/app/chat/route.js`,
 * its deterministic test model and its cookie sessions), refreshed with
 * `glirastes tools refresh`, the route's POST called in process. With the
 * request flag the generated `ui_navigate` result is marked and the request
 * ends after that step; without it the hand-off has no marker and the model
 * answers in the same request.
 */
const SHELL = resolve(EXAMPLES, 'browser-shell');
const FLAG = { glirastesUiOutcomes: 1 };

type Json = Record<string, unknown>;

let post: (request: Request) => Promise<Response>;
let cookie: string;
const previousMode = process.env.GLIRASTES_REFERENCE_TEST_MODE;

beforeAll(async () => {
  assertBuiltSdk();
  process.env.GLIRASTES_REFERENCE_TEST_MODE = '1';
  const root = await copyApp(NATIVE_APP, '.ui-outcomes-next-');
  // The browser shell's chat route, test model and sessions, as prepare-browser.mjs lays them out.
  for (const file of ['src/app/chat/route.js', 'src/test-model.js', 'src/auth.js']) {
    await cp(join(SHELL, file), join(root, file));
  }
  await runToolsPipeline({ root, mode: 'write' });
  ({ POST: post } = await import(pathToFileURL(join(root, 'src/app/chat/route.js')).href) as {
    POST: (request: Request) => Promise<Response>;
  });
  const auth = await import(pathToFileURL(join(root, 'src/auth.js')).href) as {
    createSession(user: ReturnType<typeof principal>): string;
  };
  cookie = `session=${auth.createSession(principal())}`;
}, 240_000);
afterAll(async () => {
  if (previousMode === undefined) delete process.env.GLIRASTES_REFERENCE_TEST_MODE;
  else process.env.GLIRASTES_REFERENCE_TEST_MODE = previousMode;
  await removeCopiedApps();
});

async function chat(body: Json): Promise<Json[]> {
  const response = await post(new Request('http://next.local/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Json);
}

const user = () => ({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Go to overview' }] });
const outputsOf = (chunks: Json[]) => chunks.filter((chunk) => chunk.type === 'tool-output-available');
const textOf = (chunks: Json[]) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('');
const stepsOf = (chunks: Json[]) => chunks.filter((chunk) => chunk.type === 'start-step').length;

describe('outcome protocol on the Next reference app', () => {
  it('with the flag: marks the generated navigation result and ends the request after its step', async () => {
    const chunks = await chat({ messages: [user()], ...FLAG });
    const outputs = outputsOf(chunks);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.output).toMatchObject({
      handedOff: true,
      awaitsOutcome: true,
      uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } },
    });
    expect(outputs[0]!.output).not.toHaveProperty('success');
    expect(stepsOf(chunks)).toBe(1);
    expect(textOf(chunks)).toBe('');
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  }, 60_000);

  it('continues after the reported outcome: the model answers, nothing runs again', async () => {
    const message = user();
    const [output] = outputsOf(await chat({ messages: [message], ...FLAG }));
    const chunks = await chat({
      ...FLAG,
      messages: [message, {
        id: randomUUID(),
        role: 'assistant',
        parts: [{ type: 'step-start' }, {
          type: 'tool-ui_navigate',
          toolCallId: output!.toolCallId,
          state: 'output-available',
          input: { destination: '/overview' },
          output: { ...(output!.output as Json), outcome: { v: 1, code: 'ok' } },
        }],
      }],
    });
    expect(outputsOf(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe('Reference response complete.');
  }, 60_000);

  it('without the flag: the 0.17.3 shape without marker, the model writes on in the same request', async () => {
    const chunks = await chat({ messages: [user()] });
    const outputs = outputsOf(chunks);
    expect(outputs).toHaveLength(1);
    const output = outputs[0]!.output as Json;
    expect(Object.keys(output).sort()).toEqual(['message', 'success', 'uiAction']);
    expect(output).toMatchObject({ success: true, uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } } });
    expect(stepsOf(chunks)).toBe(2);
    expect(textOf(chunks)).toBe('Reference response complete.');
  }, 60_000);
});
