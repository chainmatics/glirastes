// @vitest-environment jsdom

import React, { useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLIRASTES_NAVIGATE_ACTION_ID,
  registerDocumentNavigation,
  registerNavigationBridge,
  UiActionBus,
} from '../../../browser/index.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, SessionConfig, UiActionOutcomeEvent } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

type Status = ChatTransport['status'];
type ToolOutput = { tool: string; toolCallId: string; output: Record<string, unknown> };

let control: {
  set(messages: ChatMessage[], status?: Status): void;
  status(status: Status): void;
  messages(): ChatMessage[];
};
const written: ToolOutput[] = [];
const continued = vi.fn();
const reporting: boolean[] = [];
const loading: boolean[] = [];
let warn: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  written.length = 0;
  reporting.length = 0;
  loading.length = 0;
  continued.mockReset();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

function LoadingProbe() {
  const { isLoading } = useChatContext();
  loading.push(isLoading);
  return null;
}

/** A transport like the bundled one: `addToolOutput` replaces the output in the last message. */
function Host({ initial = [], config, withOutputs = true }: {
  initial?: ChatMessage[];
  config: AiChatProviderConfig & { session?: SessionConfig };
  withOutputs?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [status, setStatus] = useState<Status>('ready');
  control = {
    set: (next, nextStatus) => {
      setMessages(next);
      if (nextStatus) setStatus(nextStatus);
    },
    status: setStatus,
    messages: () => messages,
  };
  const outputs = useMemo(() => ({
    addToolOutput: (value: ToolOutput) => {
      written.push(value);
      setMessages((current) => current.map((message, index) => (index !== current.length - 1 ? message : {
        ...message,
        parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === value.toolCallId
          ? { ...part, output: value.output }
          : part)),
      }) as ChatMessage));
    },
    continueTurn: () => { continued(); },
    setUiOutcomeReporting: (enabled: boolean) => { reporting.push(enabled); },
  }), []);
  const transport = useMemo<ChatTransport>(() => ({
    messages,
    status,
    error: null,
    sendMessage: async () => {},
    stop: () => {},
    setMessages,
    addToolApprovalResponse: () => {},
    ...(withOutputs ? outputs : {}),
  }), [messages, status, outputs, withOutputs]);
  return (
    <AiChatProvider transport={transport} {...config}>
      <LoadingProbe />
    </AiChatProvider>
  );
}

const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Open the tasks' }] } as ChatMessage;
const navigate = (href = '/tasks') => ({ type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href } });

function uiPart(toolCallId: string, extra: Record<string, unknown> = { awaitsOutcome: true }, uiAction: unknown = navigate()) {
  return {
    type: 'tool-ui_navigate', toolCallId, state: 'output-available', input: {},
    output: { handedOff: true, message: 'Handed to the app.', uiAction, ...extra },
  };
}
const assistant = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] } as unknown as ChatMessage);

async function stream(...messages: ChatMessage[][]) {
  await act(async () => { control.set([user], 'submitted'); });
  for (const next of messages) await act(async () => { control.set(next, 'streaming'); });
  await act(async () => { control.status('ready'); });
}

function setup(config: AiChatProviderConfig & { session?: SessionConfig } = {}, options: { initial?: ChatMessage[]; withOutputs?: boolean } = {}) {
  const bus = new UiActionBus();
  const outcomes: UiActionOutcomeEvent[] = [];
  render(
    <Host
      initial={options.initial}
      withOutputs={options.withOutputs ?? true}
      config={{ uiActionBus: bus, onUiActionOutcome: (event) => { outcomes.push(event); }, ...config }}
    />,
  );
  return { bus, outcomes };
}

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe('AiChatProvider reports UI outcomes into marked results', () => {
  it('tells the transport it reports, and stops saying so when turned off', async () => {
    setup();
    await waitFor(() => expect(reporting).toEqual([true]));
    cleanup();
    expect(reporting.at(-1)).toBe(false);
    setup({ uiActionOutcomes: false });
    await settle();
    expect(reporting.at(-1)).toBe(false);
  });

  it('writes the outcome of a marked result and reports it in the event', async () => {
    const { bus, outcomes } = setup();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    await stream([user, assistant(uiPart('c1'))]);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toEqual({
      tool: 'ui_navigate',
      toolCallId: 'c1',
      output: expect.objectContaining({ handedOff: true, awaitsOutcome: true, outcome: { v: 1, code: 'ok' } }),
    });
    expect(outcomes).toEqual([expect.objectContaining({ code: 'ok', reported: true })]);
    // The written result is processed: it never runs again.
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['without a navigation bridge', undefined, { v: 1, code: 'unavailable' }],
    ['with a refusing bridge', () => false, { v: 1, code: 'rejected-handler' }],
  ])('writes the code %s', async (_name, push, outcome) => {
    const { bus } = setup();
    if (push) cleanups.push(registerNavigationBridge({ bus, push }));
    await stream([user, assistant(uiPart('c1'))]);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.output.outcome).toEqual(outcome);
  });

  it('writes no code on a timeout (not confirmed)', async () => {
    const { bus, outcomes } = setup({ uiActionOutcomeTimeoutMs: 20 });
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}) }));
    await stream([user, assistant(uiPart('c1'))]);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.output.outcome).toEqual({ v: 1 });
    expect(outcomes[0]).toMatchObject({ code: 'timeout', reported: true });
  });

  it('writes nothing for an unmarked result, without addToolOutput, or with uiActionOutcomes false', async () => {
    for (const [config, options] of [
      [{}, {}],
      [{}, { withOutputs: false }],
      [{ uiActionOutcomes: false }, {}],
    ] as const) {
      const { bus, outcomes } = setup(config, options);
      cleanups.push(registerNavigationBridge({ bus, push: () => {} }));
      const extra = Object.keys(options).length === 0 && Object.keys(config).length === 0 ? {} : { awaitsOutcome: true };
      await stream([user, assistant(uiPart('c1', extra))]);
      await waitFor(() => expect(outcomes).toHaveLength(1));
      expect(outcomes[0]!.reported).toBe(false);
      cleanup();
    }
    expect(written).toEqual([]);
  });

  it('writes a report-only result without locking the composer', async () => {
    const { bus } = setup();
    let release!: () => void;
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) }));
    await stream([user, assistant(uiPart('c1', { awaitsOutcome: false }))]);
    await settle();
    expect(loading.at(-1)).toBe(false);
    await act(async () => { release(); });
    await waitFor(() => expect(written).toHaveLength(1));
  });

  it('keeps the composer locked until the outcome of a confirmed result is written', async () => {
    const { bus } = setup();
    let release!: () => void;
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) }));
    await stream([user, assistant(uiPart('c1'))]);
    await settle();
    expect(loading.at(-1)).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(written).toHaveLength(1));
    await waitFor(() => expect(loading.at(-1)).toBe(false));
  });

  it('writes each result of a step in call order, the first failure not stopping the second', async () => {
    const { bus } = setup();
    cleanups.push(registerNavigationBridge({ bus, push: (href) => href !== '/first' }));
    await stream([user, assistant(uiPart('c1', { awaitsOutcome: true }, navigate('/first')), uiPart('c2', { awaitsOutcome: true }, navigate('/second')))]);
    await waitFor(() => expect(written).toHaveLength(2));
    expect(written.map((entry) => [entry.toolCallId, entry.output.outcome])).toEqual([
      ['c1', { v: 1, code: 'rejected-handler' }],
      ['c2', { v: 1, code: 'ok' }],
    ]);
  });

  it('drops an outcome that arrives after the chat was cleared', async () => {
    const { bus } = setup();
    let release!: () => void;
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) }));
    await stream([user, assistant(uiPart('c1'))]);
    await act(async () => { control.set([]); });
    await act(async () => { release(); });
    await settle();
    expect(written).toEqual([]);
  });
});

describe('a UI action that loads a new page', () => {
  it('writes and saves initiated before the page load starts, and never sends again on this page', async () => {
    const order: string[] = [];
    const saved: ChatMessage[][] = [];
    const outcomeOf = (messages: ChatMessage[]) => (messages.at(-1)?.parts as Array<{ toolCallId?: string; output?: { outcome?: unknown } }> | undefined)
      ?.find((entry) => entry.toolCallId === 'c1')?.output?.outcome;
    const session: SessionConfig = {
      load: async () => [],
      save: async (_id, messages) => {
        if (!outcomeOf(messages)) return;
        order.push('save');
        saved.push(messages);
      },
    };
    const { bus, outcomes } = setup({ session });
    const assign = vi.fn(() => { order.push('assign'); });
    vi.stubGlobal('location', { assign });
    cleanups.push(registerDocumentNavigation({ bus }));
    await settle();
    order.length = 0;
    saved.length = 0;
    const before = Date.now();
    await stream([user, assistant(uiPart('c1', { awaitsOutcome: true }, navigate('/reports')))]);
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(order.indexOf('save')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('assign'));
    const part = (saved[0]!.at(-1)!.parts as Array<{ toolCallId?: string; output?: { outcome?: { code?: string; at?: number } } }>)
      .find((entry) => entry.toolCallId === 'c1');
    expect(part?.output?.outcome).toMatchObject({ v: 1, code: 'initiated' });
    expect(part!.output!.outcome!.at).toBeGreaterThanOrEqual(before);
    expect(written).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ code: 'initiated', reported: true });
    expect(continued).not.toHaveBeenCalled();
  });

  it('cuts off a later waiting result of the same step as not confirmed when the page loads', async () => {
    const saved: ChatMessage[][] = [];
    const session: SessionConfig = { load: async () => [], save: async (_id, messages) => { saved.push(messages); } };
    const { bus } = setup({ session });
    vi.stubGlobal('location', { assign: vi.fn() });
    cleanups.push(registerDocumentNavigation({ bus }));
    const later = vi.fn();
    cleanups.push(bus.subscribeById('toast.show', later));
    await settle();
    await stream([user, assistant(
      uiPart('c1', { awaitsOutcome: true }, navigate('/reports')),
      uiPart('c2', { awaitsOutcome: true }, { type: 'glirastes.action', actionId: 'toast.show', payload: {} }),
    )]);
    const outcomesOf = (messages: ChatMessage[]) => (messages.at(-1)!.parts as Array<{ toolCallId?: string; output?: { outcome?: unknown } }>)
      .filter((part) => part.toolCallId).map((part) => part.output?.outcome);
    await waitFor(() => expect(saved.some((messages) => outcomesOf(messages)[1] !== undefined)).toBe(true));
    const kept = saved.find((messages) => outcomesOf(messages)[1] !== undefined)!;
    expect(outcomesOf(kept)).toEqual([expect.objectContaining({ code: 'initiated' }), { v: 1 }]);
    // Only the saved copy is cut off; in this page only the navigation's outcome was written.
    expect(written.map((entry) => entry.toolCallId)).toEqual(['c1']);
    await settle();
    expect(later).not.toHaveBeenCalled();
  });

  it('holds the page load until a parallel call of the step has its result, and saves it', async () => {
    const saved: ChatMessage[][] = [];
    const session: SessionConfig = { load: async () => [], save: async (_id, messages) => { saved.push(messages); } };
    const { bus } = setup({ session });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    cleanups.push(registerDocumentNavigation({ bus }));
    await settle();
    const open = { type: 'tool-tasks_list', toolCallId: 'c2', state: 'input-available', input: {} };
    const done = { ...open, state: 'output-available', output: { success: true, tasks: [] } };
    await act(async () => { control.set([user], 'submitted'); });
    await act(async () => { control.set([user, assistant(uiPart('c1', { awaitsOutcome: true }, navigate('/reports')), open)], 'streaming'); });
    await settle(60);
    expect(assign).not.toHaveBeenCalled();
    await act(async () => { control.set([user, assistant(uiPart('c1', { awaitsOutcome: true }, navigate('/reports')), done)], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const last = saved.at(-1)!.at(-1)!.parts as Array<{ toolCallId?: string; state?: string; output?: { outcome?: { code?: string } } }>;
    expect(last.find((part) => part.toolCallId === 'c2')?.state).toBe('output-available');
    expect(last.find((part) => part.toolCallId === 'c1')?.output?.outcome).toMatchObject({ code: 'initiated' });
  });

  it('keeps initiated when preparing the page load outlasts the outcome timeout', async () => {
    const session: SessionConfig = {
      load: async () => [],
      save: () => new Promise<void>((resolve) => { setTimeout(resolve, 200); }),
    };
    const { bus, outcomes } = setup({ session, uiActionOutcomeTimeoutMs: 50 });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    cleanups.push(registerDocumentNavigation({ bus }));
    await settle();
    const open = { type: 'tool-tasks_list', toolCallId: 'c2', state: 'input-available', input: {} };
    await act(async () => { control.set([user], 'submitted'); });
    // The parallel call never finishes within the timeout.
    await act(async () => { control.set([user, assistant(uiPart('c1', { awaitsOutcome: true }, navigate('/reports')), open)], 'streaming'); });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await settle(50);
    expect(written.map((entry) => entry.output.outcome)).toEqual([expect.objectContaining({ code: 'initiated' })]);
    expect(outcomes[0]).toMatchObject({ code: 'initiated', reported: true });
    expect(continued).not.toHaveBeenCalled();
  });

  it('writes the refusal of a push that comes after the outcome timeout, and keeps running later results', async () => {
    const session: SessionConfig = {
      load: async () => [],
      save: () => new Promise<void>((resolve) => { setTimeout(resolve, 200); }),
    };
    const { bus } = setup({ session, uiActionOutcomeTimeoutMs: 50 });
    cleanups.push(registerNavigationBridge({ bus, push: () => false, reloads: true }));
    const later = vi.fn();
    cleanups.push(bus.subscribeById('toast.show', later));
    await settle();
    await stream([user, assistant(
      uiPart('c1', { awaitsOutcome: true }, navigate('/reports')),
      uiPart('c2', { awaitsOutcome: true }, { type: 'glirastes.action', actionId: 'toast.show', payload: {} }),
    )]);
    await waitFor(() => expect(later).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await waitFor(() => {
      const final = new Map(written.map((entry) => [entry.toolCallId, entry.output.outcome]));
      expect(final.get('c1')).toEqual({ v: 1, code: 'rejected-handler' });
      expect(final.get('c2')).toEqual({ v: 1, code: 'ok' });
    });
  });

  it('releases the chat when a reloading push never settles: not confirmed, composer unlocked', async () => {
    const { bus, outcomes } = setup({ uiActionOutcomeTimeoutMs: 20 });
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}), reloads: true }));
    await stream([user, assistant(uiPart('c1'))]);
    await waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 12_000 });
    expect(written.at(-1)!.output.outcome).toEqual({ v: 1 });
    expect(outcomes[0]).toMatchObject({ code: 'unconfirmed', reported: true });
    await waitFor(() => expect(loading.at(-1)).toBe(false));
  }, 15_000);

  it('releases the chat at once when it is cleared while a page load hangs', async () => {
    const { bus, outcomes } = setup({ uiActionOutcomeTimeoutMs: 20 });
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}), reloads: true }));
    await stream([user, assistant(uiPart('c1'))]);
    await settle(60);
    await act(async () => { control.set([]); });
    await waitFor(() => expect(loading.at(-1)).toBe(false), { timeout: 1_000 });
    expect(outcomes).toEqual([]);
  });

  it('runs the later results and writes their own codes when a reloading bridge refuses the navigation', async () => {
    const { bus } = setup();
    cleanups.push(registerNavigationBridge({ bus, push: () => false, reloads: true }));
    cleanups.push(bus.subscribeById('toast.show', () => {}));
    await stream([user, assistant(
      uiPart('c1', { awaitsOutcome: true }, navigate('/reports')),
      uiPart('c2', { awaitsOutcome: true }, { type: 'glirastes.action', actionId: 'toast.show', payload: {} }),
    )]);
    await waitFor(() => expect(written.filter((entry) => entry.output.outcome && (entry.output.outcome as { code?: string }).code !== 'initiated')).toHaveLength(2));
    const final = new Map(written.map((entry) => [entry.toolCallId, entry.output.outcome]));
    expect(final.get('c1')).toEqual({ v: 1, code: 'rejected-handler' });
    expect(final.get('c2')).toEqual({ v: 1, code: 'ok' });
  });

  it("does not answer another chat's page load for its own running result", async () => {
    const { bus } = setup();
    let release!: () => void;
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) }));
    await stream([user, assistant(uiPart('c1'))]);
    await settle();
    // Another chat's bridge loads a page for an action of its own.
    const other = new UiActionBus();
    vi.stubGlobal('location', { assign: vi.fn() });
    cleanups.push(registerDocumentNavigation({ bus: other }));
    await act(async () => { await other.dispatch(navigate('/elsewhere')); });
    expect(written).toEqual([]);
    await act(async () => { release(); });
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.output.outcome).toEqual({ v: 1, code: 'ok' });
  });

  it('writes initiated when the page goes while an action runs (a bridge that reloads without saying so)', async () => {
    const { bus } = setup();
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}) }));
    await stream([user, assistant(uiPart('c1'))]);
    await settle();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(written).toHaveLength(1);
    expect(written[0]!.output.outcome).toMatchObject({ v: 1, code: 'initiated' });
  });

  function storedTurn(at: number, after: unknown[] = []): ChatMessage[] {
    return [user, assistant(uiPart('c1', { awaitsOutcome: true, outcome: { v: 1, code: 'initiated', at } }), ...after)];
  }

  it('continues the turn once on the new page, as a model call only', async () => {
    const run = vi.fn();
    const session: SessionConfig = { load: async () => storedTurn(Date.now() - 2_000), save: async () => {} };
    const { bus } = setup({ session });
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, run));
    await waitFor(() => expect(continued).toHaveBeenCalledTimes(1));
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    // The same history loaded again (another remount) does not continue twice.
    cleanup();
    setup({ session });
    await settle(60);
    expect(continued).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['after a minute', () => storedTurn(Date.now() - 61_000)],
    ['when text follows', () => storedTurn(Date.now(), [{ type: 'text', text: 'Opened the reports.' }])],
    ['without a page load', () => [user, assistant(uiPart('c1', { awaitsOutcome: true, outcome: { v: 1, code: 'ok' } }))]],
  ])('does not continue %s', async (_name, history) => {
    const session: SessionConfig = { load: async () => history(), save: async () => {} };
    setup({ session });
    await settle(60);
    expect(continued).not.toHaveBeenCalled();
  });

  it('does not continue with uiActionOutcomes false', async () => {
    const session: SessionConfig = { load: async () => storedTurn(Date.now()), save: async () => {} };
    setup({ session, uiActionOutcomes: false });
    await settle(60);
    expect(continued).not.toHaveBeenCalled();
  });
});
