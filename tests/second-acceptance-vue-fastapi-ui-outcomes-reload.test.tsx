// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerDocumentNavigation } from '../src/browser/index.js';
import { UI_OUTCOME_MODEL_TEXTS } from '../src/contracts/index.js';
import { AiChatProvider } from '../src/react/provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../src/react/provider/chat-context.js';
import { useVercelAiChatTransport } from '../src/react/transports/vercel.js';
import type { ChatMessage, SessionConfig } from '../src/react/types.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  pythonReady,
  refreshWithCli,
  removeCopiedApps,
  VUE_APP,
  type BootedFastapiApp,
} from './support/tool-runtime.js';

/**
 * The outcome protocol end to end for an app WITHOUT client routing, on the
 * Vue+FastAPI fixture: the real chat runtime (runtime/chat.mjs) with a
 * scripted model, the React provider and the bundled Vercel transport in
 * jsdom, `registerDocumentNavigation()` with `location` stubbed. The
 * navigation saves `initiated` before `location.assign`; the "new page" (a
 * new provider on the same session) continues the turn exactly once, as a
 * model call that reads the fixed `initiated` text.
 */
const PYTHON_READY = pythonReady();
const ASK = 'Open the overview';

type Json = Record<string, unknown>;

let app: BootedFastapiApp;
const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
  const last = prompt.at(-1);
  const asked = last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === ASK);
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const chunks = asked
    ? [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'ui_navigate', input: JSON.stringify({ destination: '/overview' }) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
    ]
    : [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: 'I opened the overview.' },
      { type: 'text-end' as const, id: 'answer' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
    ];
  return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
} });

beforeAll(async () => {
  if (!PYTHON_READY) return;
  assertBuiltSdk();
  // jsdom rewrites import.meta.url: the in-process pipeline cannot spawn its probe here, the CLI can.
  const root = await copyApp(VUE_APP, '.second-acceptance-ui-reload-');
  await refreshWithCli(root);
  app = await bootFastapiApp(root, () => model);
}, 240_000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await closeFastapiApps();
  await removeCopiedApps();
});

let chatContext: ChatContextValue;

function Probe() {
  chatContext = useChatContext();
  return null;
}

/** One page of the app: the bundled transport against the runtime, the provider with the shared session. */
function Page({ session }: { session: SessionConfig }) {
  const transport = useVercelAiChatTransport({
    endpoint: `${app.runtimeOrigin}/api/chat`,
    headers: { authorization: `Bearer ${app.token}` },
  });
  return (
    <AiChatProvider transport={transport} session={session}>
      <Probe />
    </AiChatProvider>
  );
}

type ToolPart = { type: string; toolCallId?: string; output?: { awaitsOutcome?: unknown; outcome?: { v?: number; code?: string; at?: number } } };

function navigationPartOf(messages: ReadonlyArray<ChatMessage> | undefined): ToolPart | undefined {
  return (messages?.at(-1)?.parts as ToolPart[] | undefined)?.find((part) => part.type === 'tool-ui_navigate');
}

describe.skipIf(!PYTHON_READY)('second acceptance fixture: a navigation that loads a new page', () => {
  it('saves initiated before location.assign and continues the turn once on the new page', async () => {
    sessionStorage.clear();
    // The in-memory store of the app's chat history, shared by both pages.
    let stored: ChatMessage[] = [];
    const saves: ChatMessage[][] = [];
    const order: string[] = [];
    const session: SessionConfig = {
      load: async () => structuredClone(stored),
      save: async (_id, messages) => {
        stored = structuredClone(messages);
        saves.push(stored);
        if (navigationPartOf(messages)?.output?.outcome) order.push('save-outcome');
      },
    };
    const assign = vi.fn((_href: string) => { order.push('assign'); });
    vi.stubGlobal('location', { assign, href: 'http://app.local/tasks' });

    // Every POST the browser sends to the runtime.
    const realFetch = globalThis.fetch;
    const bodies: Json[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Json);
      return realFetch(input, init);
    });

    const stop = registerDocumentNavigation();
    try {
      // First page: the user asks, the server marks the result and stops, the browser loads the page.
      const first = render(<Page session={session} />);
      await waitFor(() => expect(chatContext).toBeDefined());
      await waitFor(() => expect(chatContext.isLoading).toBe(false));
      await act(async () => { expect(chatContext.send(ASK)).toBe(true); });
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1), { timeout: 15_000 });
      expect(assign).toHaveBeenCalledWith('/overview');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ glirastesUiOutcomes: 1 });
      expect(model.doStreamCalls).toHaveLength(1);
      // Saved with `initiated` before the page load started.
      expect(order.indexOf('save-outcome')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('save-outcome')).toBeLessThan(order.indexOf('assign'));
      const part = navigationPartOf(stored);
      expect(part?.output?.awaitsOutcome).toBe(true);
      expect(part?.output?.outcome).toMatchObject({ v: 1, code: 'initiated' });
      expect(typeof part?.output?.outcome?.at).toBe('number');
      // The page is gone: nothing more is sent from it.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(bodies).toHaveLength(1);
      first.unmount();

      // The new page: a new provider loads the same history and continues the turn once.
      const userMessages = (stored as Array<{ role: string }>).filter((message) => message.role === 'user').length;
      render(<Page session={session} />);
      await waitFor(() => expect(bodies).toHaveLength(2), { timeout: 15_000 });
      await waitFor(() => expect(model.doStreamCalls).toHaveLength(2), { timeout: 15_000 });
      const continuation = bodies[1]!;
      expect(continuation).toMatchObject({ glirastesUiOutcomes: 1 });
      const sent = continuation.messages as Array<{ role: string; parts: ToolPart[] }>;
      expect(sent.filter((message) => message.role === 'user')).toHaveLength(userMessages);
      expect(sent.at(-1)?.role).toBe('assistant');
      expect(navigationPartOf(sent as unknown as ChatMessage[])?.output?.outcome).toMatchObject({ v: 1, code: 'initiated' });
      const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
      expect(prompt).toContain(UI_OUTCOME_MODEL_TEXTS.initiated);
      expect(prompt).not.toContain('awaitsOutcome');
      // The answer arrives and is saved; no second continuation, no second page load.
      await waitFor(() => expect(JSON.stringify(stored)).toContain('I opened the overview.'), { timeout: 15_000 });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      expect(bodies).toHaveLength(2);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(saves.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  }, 120_000);
});
