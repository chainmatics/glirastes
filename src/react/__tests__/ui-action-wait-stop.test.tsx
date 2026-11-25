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
import React from 'react';
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
import type { AiChatProviderConfig, TurnOutcome, UiActionOutcomeEvent } from '../types.js';
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
function uiStep(request: ControlledRequest, uiAction: unknown, options: { open?: boolean } = {}) {
  request.push({ type: 'start' });
  request.push({ type: 'start-step' });
  request.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'ui_confirm', input: {} });
  request.push({ type: 'tool-output-available', toolCallId: 'c1', output: handedOff(uiAction) });
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

function Chat({ config }: { config: AiChatProviderConfig }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  transportStatus = transport.status;
  return <AiChatProvider transport={transport} {...config}><Probe /></AiChatProvider>;
}

/** The `ui_confirm` result in a request's history (or the chat's), and the user texts a request carried. */
function toolOutput(messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>): Record<string, unknown> | undefined {
  for (const message of messages) {
    for (const part of message.parts as Array<{ toolCallId?: string; output?: Record<string, unknown> }>) {
      if (part.toolCallId === 'c1') return part.output;
    }
  }
  return undefined;
}
const sentMessages = (request: ControlledRequest) => request.body.messages as Array<{ role: string; parts: unknown[] }>;
const lastRole = (request: ControlledRequest) => sentMessages(request).at(-1)?.role;
const userTexts = (request: ControlledRequest) => sentMessages(request)
  .filter((message) => message.role === 'user')
  .map((message) => (message.parts as Array<{ text?: string }>).map((part) => part.text ?? '').join(''));

function mount(config: AiChatProviderConfig = {}) {
  const bus = new UiActionBus();
  const outcomes: UiActionOutcomeEvent[] = [];
  const turnEnds: TurnOutcome[] = [];
  render(<Chat config={{
    uiActionBus: bus,
    onUiActionOutcome: (event) => { outcomes.push(event); },
    onTurnEnd: (outcome) => { turnEnds.push(outcome); },
    ...config,
  }} />);
  return { bus, outcomes, turnEnds };
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
async function waitingTurn(calls: ReturnType<typeof vi.fn>) {
  await until(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('Confirm the order'); });
  await until(() => expect(requests).toHaveLength(1));
  uiStep(requests[0]!, CONFIRM);
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

