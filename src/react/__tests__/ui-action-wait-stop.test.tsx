// @vitest-environment jsdom
/**
 * Stop while the chat waits for the outcome of a UI action (`awaitsOutcome`).
 *
 * The server ends the request after the step that awaits the outcome, so the
 * transport is idle while a handler (an app dialog) still runs; the chat stays
 * busy through the awaited outcome. Runs the provider with the bundled
 * transport (`useVercelAiChatTransport`) against a stubbed `fetch`, so the
 * continuation is decided where it is in an app: in the AI SDK's
 * `sendAutomaticallyWhen`. Fake timers: the handler takes 5 s, the outcome
 * timeout is the default 10 s.
 */
import React, { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import {
  GLIRASTES_NAVIGATE_ACTION_ID,
  registerNavigationBridge,
  UI_ACTION_OUTCOME_TIMEOUT_MS,
  UiActionBus,
} from '../../browser/index.js';
import type { AiChatProviderConfig, SessionConfig, TurnOutcome, UiActionOutcomeEvent } from '../types.js';
import { ctx, Probe } from './streaming-chat.js';
import { stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
let transportStatus: string | undefined;
let warn: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  ({ requests } = stubControlledFetch());
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const request of requests) request.close();
  for (const stop of cleanups.splice(0)) stop();
  cleanup();
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the stream, React and due timers run (fake timers: `ms` of virtual time). */
const advance = (ms = 0) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise((resolve) => setImmediate(resolve));
});
async function until(check: () => void, rounds = 200) {
  for (let round = 0; ; round += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (round >= rounds) throw error;
    }
    await advance(1);
  }
}

const CONFIRM = { type: 'glirastes.action', actionId: 'orders.confirm', payload: { id: 'o1' } };
const NAVIGATE = { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/reports' } };
const handedOff = (uiAction: unknown) => ({ handedOff: true, message: 'Handed to the app.', uiAction, awaitsOutcome: true });

/** The server's step that hands a UI action off and awaits its outcome; it ends the request unless `open`. */
function uiStep(request: ControlledRequest, uiAction: unknown, options: { open?: boolean; more?: unknown[] } = {}) {
  request.push({ type: 'start' });
  request.push({ type: 'start-step' });
  for (const [index, action] of [uiAction, ...(options.more ?? [])].entries()) {
    const toolCallId = `c${index + 1}`;
    request.push({ type: 'tool-input-available', toolCallId, toolName: 'ui_confirm', input: {} });
    request.push({ type: 'tool-output-available', toolCallId, output: handedOff(action) });
  }
  if (options.open) return;
  request.push({ type: 'finish-step' });
  request.push({ type: 'finish' });
  request.end();
}

function answer(request: ControlledRequest, text: string) {
  for (const chunk of textChunks(text)) request.push(chunk);
  request.push({ type: 'text-end', id: 't' });
  request.push({ type: 'finish-step' });
  request.push({ type: 'finish' });
  request.end();
}

function Chat({ config }: { config: AiChatProviderConfig & { session?: SessionConfig } }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  transportStatus = transport.status;
  return <AiChatProvider transport={transport} {...config}><Probe /></AiChatProvider>;
}

/** The `ui_confirm` result in a request's history (or the chat's), and the user texts a request carried. */
function toolOutput(messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>, id = 'c1'): Record<string, unknown> | undefined {
  for (const message of messages) {
    for (const part of message.parts as Array<{ toolCallId?: string; output?: Record<string, unknown> }>) {
      if (part.toolCallId === id) return part.output;
    }
  }
  return undefined;
}
const sentMessages = (request: ControlledRequest) => request.body.messages as Array<{ role: string; parts: unknown[] }>;
const lastRole = (request: ControlledRequest) => sentMessages(request).at(-1)?.role;
const userTexts = (request: ControlledRequest) => sentMessages(request)
  .filter((message) => message.role === 'user')
  .map((message) => (message.parts as Array<{ text?: string }>).map((part) => part.text ?? '').join(''));

function mount(config: AiChatProviderConfig & { session?: SessionConfig } = {}, options: { strict?: boolean } = {}) {
  const bus = new UiActionBus();
  const outcomes: UiActionOutcomeEvent[] = [];
  const turnEnds: TurnOutcome[] = [];
  const chat = <Chat config={{
    uiActionBus: bus,
    onUiActionOutcome: (event) => { outcomes.push(event); },
    onTurnEnd: (outcome) => { turnEnds.push(outcome); },
    ...config,
  }} />;
  const view = render(options.strict ? <StrictMode>{chat}</StrictMode> : chat);
  return { bus, outcomes, turnEnds, view };
}

/** A handler that answers after `ms` (an app dialog the user confirms). */
function dialog(bus: UiActionBus, ms: number) {
  const calls = vi.fn();
  const done = vi.fn();
  const state = { startedAt: 0 };
  cleanups.push(bus.subscribeById('orders.confirm', () => {
    calls();
    state.startedAt = Date.now();
    return new Promise<void>((resolve) => { setTimeout(() => { done(); resolve(); }, ms); });
  }));
  /** Advances to `ms` after the handler started. */
  const at = (ms: number) => advance(Math.max(0, state.startedAt + ms - Date.now()));
  return { calls, done, at };
}

/** Sends the first message; its request ends with the UI step; the handler runs. */
async function waitingTurn(calls: ReturnType<typeof vi.fn>, more: unknown[] = []) {
  await until(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('Confirm the order'); });
  await until(() => expect(requests).toHaveLength(1));
  uiStep(requests[0]!, CONFIRM, { more });
  await until(() => expect(calls).toHaveBeenCalledTimes(1));
  await until(() => expect(transportStatus).toBe('ready'));
  // The transport is idle, the chat waits for the outcome.
  expect(ctx.isLoading).toBe(true);
}

const firstTurn = () => ctx.turnOutcomes.get(ctx.messages.find((message) => message.role === 'user')!.id);

describe('Stop while the chat waits for a UI action outcome', () => {
  it('ends the waiting at once: no outcome, no continuation (also once the handler settles), turn stopped', async () => {
    const { bus, outcomes, turnEnds } = mount();
    const { calls, done, at } = dialog(bus, 5_000);
    await waitingTurn(calls);

    await at(1_000);
    await act(async () => { ctx.stop(); });
    await advance(0);

    expect(ctx.isLoading).toBe(false);
    expect(outcomes).toEqual([expect.objectContaining({ toolCallId: 'c1', code: 'unconfirmed', reported: false })]);
    expect(toolOutput(ctx.messages)).not.toHaveProperty('outcome');
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'stopped' });
    expect(turnEnds).toEqual([expect.objectContaining({ status: 'aborted', reason: 'stopped' })]);

    // The dialog answers after 5 s, the 10 s outcome timeout passes: nothing more happens.
    await at(5_000);
    expect(done).toHaveBeenCalledTimes(1);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    await advance(0);
    expect(requests).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(toolOutput(ctx.messages)).not.toHaveProperty('outcome');
    expect(ctx.isLoading).toBe(false);
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'stopped' });
    expect(turnEnds).toHaveLength(1);

    // The next turn carries the result without an outcome: the server tells the model "not confirmed".
    await act(async () => { ctx.send('Next'); });
    await until(() => expect(requests).toHaveLength(2));
    expect(userTexts(requests[1]!)).toEqual(['Confirm the order', 'Next']);
    const carriedOutput = toolOutput(sentMessages(requests[1]!));
    expect(carriedOutput).toMatchObject({ awaitsOutcome: true });
    expect(carriedOutput).not.toHaveProperty('outcome');
  });

  it('pin: a handler that settles in time writes its outcome and the turn continues', async () => {
    const { bus, outcomes } = mount();
    const { calls } = dialog(bus, 500);
    await waitingTurn(calls);
    await advance(500);
    await until(() => expect(requests).toHaveLength(2));
    expect(lastRole(requests[1]!)).toBe('assistant');
    expect(toolOutput(sentMessages(requests[1]!))).toMatchObject({ outcome: { v: 1, code: 'ok' } });
    expect(outcomes).toEqual([expect.objectContaining({ code: 'ok', reported: true })]);
    answer(requests[1]!, 'Confirmed.');
    await until(() => expect(ctx.isLoading).toBe(false));
    expect(firstTurn()).toMatchObject({ status: 'completed', reason: 'finished' });
  });

  it('pin: a handler that never settles times out after 10 s, writes "not confirmed" and the turn continues', async () => {
    const { bus, outcomes } = mount();
    const { calls, at } = dialog(bus, 60_000);
    await waitingTurn(calls);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS - 1);
    expect(requests).toHaveLength(1);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS);
    await until(() => expect(requests).toHaveLength(2));
    expect(toolOutput(sentMessages(requests[1]!))).toMatchObject({ outcome: { v: 1 } });
    expect(toolOutput(sentMessages(requests[1]!))?.outcome).not.toHaveProperty('code');
    expect(outcomes).toEqual([expect.objectContaining({ code: 'timeout', reported: true })]);
  });

  it('pin: Stop during a normal stream ends the request and records the stop', async () => {
    const { turnEnds } = mount();
    await until(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('Hello'); });
    await until(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('Hi ')) requests[0]!.push(chunk);
    await until(() => expect(transportStatus).toBe('streaming'));
    await act(async () => { ctx.stop(); });
    await until(() => expect(ctx.isLoading).toBe(false));
    expect(requests[0]!.aborted).toBe(true);
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'stopped' });
    await advance(UI_ACTION_OUTCOME_TIMEOUT_MS);
    expect(requests).toHaveLength(1);
    expect(turnEnds).toEqual([expect.objectContaining({ status: 'aborted', reason: 'stopped' })]);
  });
});

describe('queue.sendNow while the chat waits for a UI action outcome', () => {
  async function queueOther() {
    await act(async () => { expect(ctx.submit('Other')).toBe('queued'); });
    return ctx.queue.items[0]!.id;
  }

  it("'abort' (default) ends the waiting, sends the message next, and a later Stop counts as stopped", async () => {
    const { bus, outcomes, turnEnds } = mount({ queue: { enabled: true } });
    const { calls, at } = dialog(bus, 5_000);
    await waitingTurn(calls);
    const id = await queueOther();
    await at(1_000);

    await act(async () => { expect(ctx.sendNow(id)).toBe(true); });
    await until(() => expect(requests).toHaveLength(2));
    expect(lastRole(requests[1]!)).toBe('user');
    expect(userTexts(requests[1]!)).toEqual(['Confirm the order', 'Other']);
    expect(toolOutput(sentMessages(requests[1]!))).not.toHaveProperty('outcome');
    expect(outcomes).toEqual([expect.objectContaining({ code: 'unconfirmed', reported: false })]);
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'send-now' });
    expect(ctx.queue.items).toHaveLength(0);
    expect(ctx.queue.paused).toBe(false);

    // The user stops the message that went out: a stop, not a send-now.
    for (const chunk of textChunks('Partial ')) requests[1]!.push(chunk);
    await until(() => expect(transportStatus).toBe('streaming'));
    await act(async () => { ctx.stop(); });
    await until(() => expect(ctx.isLoading).toBe(false));
    const second = ctx.messages.filter((message) => message.role === 'user')[1]!;
    expect(ctx.turnOutcomes.get(second.id)).toMatchObject({ status: 'aborted', reason: 'stopped' });

    // The dialog answers later: nothing is written, nothing starts.
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    expect(requests).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
    expect(turnEnds.map((outcome) => outcome.reason)).toEqual(['send-now', 'stopped']);
  });

  it("'next' aborts nothing: the message goes out after the waiting and its continuation ended", async () => {
    const { bus, outcomes } = mount({ queue: { enabled: true, sendNowBehavior: 'next' } });
    const { calls, at } = dialog(bus, 5_000);
    await waitingTurn(calls);
    const id = await queueOther();
    await at(1_000);
    await act(async () => { expect(ctx.sendNow(id)).toBe(true); });
    await advance(0);
    expect(requests).toHaveLength(1);
    expect(ctx.isLoading).toBe(true);
    expect(outcomes).toEqual([]);

    await at(5_000);
    await until(() => expect(requests).toHaveLength(2));
    // First the continuation with the outcome, then the message.
    expect(lastRole(requests[1]!)).toBe('assistant');
    expect(toolOutput(sentMessages(requests[1]!))).toMatchObject({ outcome: { v: 1, code: 'ok' } });
    answer(requests[1]!, 'Confirmed.');
    await until(() => expect(requests).toHaveLength(3));
    expect(userTexts(requests[2]!)).toEqual(['Confirm the order', 'Other']);
    expect(firstTurn()).toMatchObject({ status: 'completed', reason: 'finished' });
  });
});

describe('Stop while a page load for a UI action is prepared', () => {
  it('cancels the page load and writes no initiated', async () => {
    const { bus, outcomes } = mount();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push, reloads: true }));
    await until(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('Open the reports'); });
    await until(() => expect(requests).toHaveLength(1));
    // The step still streams (another call may follow): the page load waits for its end.
    uiStep(requests[0]!, NAVIGATE, { open: true });
    await until(() => expect(toolOutput(ctx.messages)).toBeDefined());
    await advance(100);

    await act(async () => { ctx.stop(); });
    await advance(0);
    await advance(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);

    expect(push).not.toHaveBeenCalled();
    expect(toolOutput(ctx.messages)).not.toHaveProperty('outcome');
    expect(outcomes).toEqual([expect.objectContaining({ code: 'unconfirmed', reported: false })]);
    expect(requests).toHaveLength(1);
    expect(ctx.isLoading).toBe(false);
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'stopped' });
  });
});

describe('a bus handler that returns false is written as rejected-handler (#179)', () => {
  it('end to end: the outcome the model reads is rejected-handler, not ok', async () => {
    const { bus } = mount();
    cleanups.push(bus.subscribeById('orders.confirm', () => false));
    await until(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('Confirm the order'); });
    await until(() => expect(requests).toHaveLength(1));
    uiStep(requests[0]!, CONFIRM);
    await until(() => expect(requests).toHaveLength(2));
    expect(toolOutput(sentMessages(requests[1]!))).toMatchObject({ outcome: { v: 1, code: 'rejected-handler' } });
  });
});


describe('Stop around a page load for a UI action (reloading bridge)', () => {
  it('before the page load is prepared: the navigation never starts', async () => {
    // The result first opens a dialog (5 s), then navigates: Stop comes while the dialog is open.
    const { bus, outcomes } = mount();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push, reloads: true }));
    const { calls, at } = dialog(bus, 5_000);
    await until(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('Confirm and open the reports'); });
    await until(() => expect(requests).toHaveLength(1));
    uiStep(requests[0]!, [CONFIRM, NAVIGATE]);
    await until(() => expect(calls).toHaveBeenCalledTimes(1));
    await at(1_000);
    await act(async () => { ctx.stop(); });
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 6_000);
    expect(push).not.toHaveBeenCalled();
    expect(toolOutput(ctx.messages)).not.toHaveProperty('outcome');
    expect(outcomes).toEqual([expect.objectContaining({ code: 'unconfirmed', reported: false })]);
    expect(requests).toHaveLength(1);
  });

  it('after initiated was written (the page-load save still runs): as before, the page load goes on', async () => {
    // The save never settles (the chat waits at most 500 ms for it); Stop comes after `initiated` was written.
    const { bus, outcomes, turnEnds } = mount({
      session: { load: async () => [], save: () => new Promise<void>(() => {}) },
    });
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push, reloads: true }));
    await until(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('Open the reports'); });
    await until(() => expect(requests).toHaveLength(1));
    uiStep(requests[0]!, NAVIGATE);
    await until(() => expect(toolOutput(ctx.messages)).toMatchObject({ outcome: { v: 1, code: 'initiated' } }));
    expect(push).not.toHaveBeenCalled();
    await act(async () => { ctx.stop(); });
    await advance(1_000);
    await until(() => expect(push).toHaveBeenCalledTimes(1));
    await advance(100);
    expect(outcomes).toEqual([expect.objectContaining({ code: 'initiated', reported: true })]);
    expect(turnEnds).toEqual([]);
    expect(firstTurn()?.status).not.toBe('aborted');
    expect(requests).toHaveLength(1);
  });
});

describe('two results that wait for their outcome', () => {
  it('Stop during the first ends both: the second handler never runs, no request, one onTurnEnd', async () => {
    const { bus, outcomes, turnEnds } = mount();
    const { calls, at } = dialog(bus, 5_000);
    const second = vi.fn();
    cleanups.push(bus.subscribeById('orders.archive', second));
    await waitingTurn(calls, [{ type: 'glirastes.action', actionId: 'orders.archive', payload: {} }]);
    await at(1_000);
    await act(async () => { ctx.stop(); });
    await advance(0);
    expect(ctx.isLoading).toBe(false);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    expect(second).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      expect.objectContaining({ toolCallId: 'c1', code: 'unconfirmed', reported: false }),
      expect.objectContaining({ toolCallId: 'c2', code: 'unconfirmed', reported: false }),
    ]);
    expect(toolOutput(ctx.messages, 'c2')).not.toHaveProperty('outcome');
    expect(requests).toHaveLength(1);
    expect(turnEnds).toEqual([expect.objectContaining({ status: 'aborted', reason: 'stopped' })]);
  });

  it('StrictMode: Stop ends the wait the same way', async () => {
    const { bus, outcomes, turnEnds } = mount({}, { strict: true });
    const { calls, at } = dialog(bus, 5_000);
    await waitingTurn(calls);
    await at(1_000);
    await act(async () => { ctx.stop(); });
    await advance(0);
    expect(ctx.isLoading).toBe(false);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    expect(outcomes).toEqual([expect.objectContaining({ code: 'unconfirmed', reported: false })]);
    expect(toolOutput(ctx.messages)).not.toHaveProperty('outcome');
    expect(requests).toHaveLength(1);
    expect(firstTurn()).toMatchObject({ status: 'aborted', reason: 'stopped' });
    expect(turnEnds).toHaveLength(1);
  });
});

describe('a reset while a handler is pending (clear, session switch, unmount)', () => {
  // Since this fix the run ends with the reset at once (it honours its signal); before, the chat stayed busy
  // until the handler settled (at most the outcome timeout). Still nothing is written and nothing continues.
  it('clear(): idle at once, nothing written or sent, the next message goes out alone', async () => {
    const { bus, outcomes } = mount();
    const { calls, at } = dialog(bus, 5_000);
    await waitingTurn(calls);
    await at(1_000);
    await act(async () => { ctx.clear(); });
    await advance(0);
    const clearedAt = Date.now();
    await until(() => expect(ctx.isLoading).toBe(false), 5);
    expect(Date.now() - clearedAt).toBeLessThan(10);
    expect(ctx.isSessionChangeBlocked).toBe(false);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    expect(requests).toHaveLength(1);
    expect(outcomes).toEqual([]);
    await act(async () => { ctx.send('Next'); });
    await until(() => expect(requests).toHaveLength(2));
    expect(userTexts(requests[1]!)).toEqual(['Next']);
  });

  it('session switch: idle at once, nothing written or sent, the queue is not stuck', async () => {
    const histories: Record<string, unknown[]> = {};
    const { bus, outcomes } = mount({
      queue: { enabled: true },
      session: {
        defaultActiveId: 'A',
        load: async (id: string) => (histories[id] ?? []) as never,
        save: (id: string, messages: unknown[]) => { histories[id] = messages; },
      },
    });
    const { calls, at } = dialog(bus, 5_000);
    await waitingTurn(calls);
    await at(1_000);
    const switchedAt = Date.now();
    await act(async () => { await ctx.switchSession('B'); });
    await until(() => expect(ctx.activeSessionId).toBe('B'));
    await until(() => expect(ctx.isLoading).toBe(false), 50);
    // Not the 4 s the handler still runs: B's history loads, then the chat is idle.
    expect(Date.now() - switchedAt).toBeLessThan(100);
    expect(ctx.isSessionChangeBlocked).toBe(false);
    await act(async () => { expect(ctx.submit('In B')).toBe('sent'); });
    await until(() => expect(requests).toHaveLength(2));
    expect(userTexts(requests[1]!)).toEqual(['In B']);
    await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
    expect(requests).toHaveLength(2);
    expect(outcomes).toEqual([]);
    expect(toolOutput(histories.A as Array<{ parts: unknown[] }>)).not.toHaveProperty('outcome');
  });

  it('unmount: nothing written or sent, no React warning, also once the handler settles', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { bus, outcomes, view } = mount();
      const { calls, at } = dialog(bus, 5_000);
      await waitingTurn(calls);
      await at(1_000);
      view.unmount();
      await at(UI_ACTION_OUTCOME_TIMEOUT_MS + 1_000);
      expect(requests).toHaveLength(1);
      expect(outcomes).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
