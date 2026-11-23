// @vitest-environment jsdom

/**
 * Repro: does a navigation UI action report success (`ok`) to the model
 * although the app cancelled or refused the navigation?
 *
 * Every case pins what is reported today. A case that reports `ok` (or
 * another success) for a navigation that did not happen is an `it.fails`
 * with the intended assertion and a KNOWN DEFECT comment, tagged
 *   (a) the SDK has the information and discards it, or
 *   (b) the SDK cannot know, because the app does not report it back.
 * Correct cases are ordinary tests. Nothing here is specific to one app or
 * router; router shapes are simulated by plain functions.
 */
import React, { useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLIRASTES_NAVIGATE_ACTION_ID,
  registerAiClientAction,
  registerDocumentNavigation,
  registerNavigationBridge,
  runToolResultUiActions,
  UiActionBus,
  type UiActionHandler,
} from '../../../browser/index.js';
import { UI_OUTCOME_MODEL_TEXTS } from '../../../contracts/ui-outcome.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  SessionConfig,
  TurnOutcome,
  UiActionOutcomeEvent,
} from '../../types.js';
import { ctx, Probe } from '../../__tests__/streaming-chat.js';
import { AiChatProvider } from '../ai-chat-provider.js';

const cleanups: Array<() => void> = [];
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

const navigate = (href = '/tasks') => ({
  type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href },
});
/** What the generated `ui.navigate` / `ui.filter.<view>` tool hands to the browser (hand-off shape, marked). */
const handedOff = (uiAction: unknown) => ({ handedOff: true, message: 'Handed to the app.', uiAction, awaitsOutcome: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/**
 * A bus handler that declines with `false`. `UiActionHandler` returns
 * `void | Promise<void>`, so TypeScript refuses `() => false` there (a JS
 * handler, an `any`-typed one or a cast passes it at runtime).
 */
const declining = (handler: () => boolean | Promise<boolean>) => handler as unknown as UiActionHandler;

describe('what the model reads for each code', () => {
  it('ok tells the model the app confirmed the navigation was carried out', () => {
    expect(UI_OUTCOME_MODEL_TEXTS.ok).toMatch(/^The app confirmed the action was carried out\./);
    expect(UI_OUTCOME_MODEL_TEXTS['rejected-handler']).toMatch(/It did not happen/);
  });
});

describe('navigation bridge (registerNavigationBridge / useGlirastesNavigationBridge)', () => {
  it('reports rejected-handler when push returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: () => false }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('waits for an async push and reports rejected-handler when a guard declines later (unsaved changes)', async () => {
    const bus = new UiActionBus();
    const guard = deferred<boolean>();
    cleanups.push(registerNavigationBridge({ bus, push: async () => guard.promise }));
    let settled = false;
    const run = runToolResultUiActions(handedOff(navigate()), bus).then((value) => { settled = true; return value; });
    await tick();
    expect(settled).toBe(false); // no outcome before the push settled
    guard.resolve(false); // the user kept the page
    expect(await run).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports failed when push throws or rejects', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: async () => { throw new Error('route change aborted'); } }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'failed' });
  });

  it('passes a router result through: resolves true -> ok, resolves false on a cancelled route -> rejected-handler', async () => {
    // A router whose push resolves a boolean (true: done, false: cancelled).
    const router = { push: async (href: string) => href !== '/cancelled' };
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: router.push }));
    expect(await runToolResultUiActions(handedOff(navigate('/tasks')), bus)).toMatchObject({ code: 'ok' });
    expect(await runToolResultUiActions(handedOff(navigate('/cancelled')), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports timeout (written as "not confirmed") when push never settles', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: () => new Promise(() => {}) }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus, { timeoutMs: 20 })).toMatchObject({ code: 'timeout' });
  });

  it('reports unavailable when no bridge or handler is registered', async () => {
    expect(await runToolResultUiActions(handedOff(navigate()), new UiActionBus())).toMatchObject({ code: 'unavailable' });
  });

  // KNOWN DEFECT (a/b, borderline): the router's failure value reaches the SDK, but only `false`
  // counts as refused. A router that resolves a failure object instead of throwing (e.g. a
  // NavigationFailure), passed directly as `push: router.push` as the setup finding suggests,
  // reports ok. The JSDoc of `push` documents a wrapper (`!(await router.push(href))`).
  it.fails('does not report ok when push resolves a failure object instead of false', async () => {
    const bus = new UiActionBus();
    const router = { push: async (_href: string): Promise<unknown> => ({ type: 4, message: 'Navigation aborted by a guard' }) };
    cleanups.push(registerNavigationBridge({ bus, push: router.push }));
    const run = await runToolResultUiActions(handedOff(navigate()), bus);
    expect(run?.code).not.toBe('ok');
  });

  // KNOWN DEFECT (b): push returns nothing and the router cancels later (a blocker, an
  // unsaved-changes guard, or a router whose push is fire-and-forget). Every non-`false`
  // return counts as carried out, so the model reads "confirmed". The SDK cannot see the
  // cancel; the only documented way is that push returns or resolves `false`.
  it.fails('does not report ok when a void push is cancelled by the router afterwards', async () => {
    const bus = new UiActionBus();
    let location = '/inbox';
    const blocker = () => true; // e.g. unsaved changes: the router keeps the page
    const router = {
      push: (href: string): void => { queueMicrotask(() => { if (!blocker()) location = href; }); },
    };
    cleanups.push(registerNavigationBridge({ bus, push: router.push }));
    const run = await runToolResultUiActions(handedOff(navigate('/tasks')), bus);
    await tick();
    expect(location).toBe('/inbox');
    expect(run?.code).not.toBe('ok');
  });

  // KNOWN DEFECT (b): the app's push starts an async navigation but does not return its
  // promise, so the outcome is reported before the navigation ended and its `false` is lost.
  it.fails('does not report ok when push drops the promise of a navigation that resolves false', async () => {
    const bus = new UiActionBus();
    const router = { push: async (_href: string) => { await tick(); return false; } };
    cleanups.push(registerNavigationBridge({ bus, push: (href) => { void router.push(href); } }));
    const run = await runToolResultUiActions(handedOff(navigate()), bus);
    expect(run?.code).toBe('rejected-handler');
  });

  // KNOWN DEFECT (b): the target has no page (the router renders its not-found page). The
  // bridge only checks that the href is a safe app path, not that a route exists, and the
  // router reports nothing, so the model reads "confirmed".
  it.fails('does not report ok when the target route does not exist', async () => {
    const bus = new UiActionBus();
    const routes = new Set(['/tasks']);
    let rendered = '';
    const router = { push: (href: string): void => { rendered = routes.has(href) ? href : 'not-found'; } };
    cleanups.push(registerNavigationBridge({ bus, push: router.push }));
    const run = await runToolResultUiActions(handedOff(navigate('/no-such-page')), bus);
    expect(rendered).toBe('not-found');
    expect(run?.code).not.toBe('ok');
  });
});

describe('full page load (registerDocumentNavigation / reloads)', () => {
  // Not `ok`, but `initiated` ("is loading the page ... say it was opened"). A beforeunload
  // confirmation the user cancels keeps the page; `location.assign` returns normally and the
  // SDK cannot tell at this point. Pinned as today's behaviour (see the report: the chat
  // then also treats the page as leaving).
  it('reports initiated when location.assign returns although a beforeunload prompt kept the page', async () => {
    const bus = new UiActionBus();
    const assign = vi.fn(); // the user answered "stay": nothing is loaded
    vi.stubGlobal('location', { assign, href: 'https://app.example/inbox' });
    cleanups.push(registerDocumentNavigation({ bus }));
    expect(await runToolResultUiActions(handedOff(navigate('/tasks')), bus)).toMatchObject({ code: 'initiated' });
    expect(assign).toHaveBeenCalledWith('/tasks');
  });
});

describe('app-own navigation handlers on the bus', () => {
  it('reports rejected-handler when a client action handler (useAiClientAction / registerAiClientAction) returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerAiClientAction(GLIRASTES_NAVIGATE_ACTION_ID, () => false, undefined, { bus }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports failed when an own bus handler throws, after awaiting it', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, async () => {
      await tick();
      throw new Error('navigation cancelled');
    }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'failed' });
  });

  // KNOWN DEFECT (a): UiActionBus.dispatch awaits each handler but drops its return value, so
  // a handler subscribed directly (bus.subscribeById / useAiClientActionById) that returns
  // `false` is counted as having run. docs/ui-action-outcomes.md (Migration) tells handlers
  // to return `false`; `UiActionHandler` types the return as void, so only a JS / `any` /
  // cast handler gets `false` through, and the bus then ignores it.
  it.fails('reports rejected-handler when a handler subscribed by id returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, declining(() => false)));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  // KNOWN DEFECT (a): same for a handler subscribed by type (useAiClientActionByType).
  it.fails('reports rejected-handler when a handler subscribed by type returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeByType('glirastes.navigate', declining(() => false)));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  // KNOWN DEFECT (a): same for an async handler that resolves false once its guard declined.
  it.fails('reports rejected-handler when an async bus handler resolves false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, declining(async () => { await tick(); return false; })));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  // KNOWN DEFECT (a): a hand-written UI tool with `outcome: 'confirm'` and its own navigation
  // action type; its handler (useAiClientActionByType) declines with `false` and is reported ok.
  it.fails('reports rejected-handler for an opted-in own navigation action whose handler returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeByType('app.navigate', declining(() => false)));
    const run = await runToolResultUiActions(handedOff({ type: 'app.navigate', path: '/tasks' }), bus);
    expect(run).toMatchObject({ code: 'rejected-handler' });
  });
});

// End to end: the chat writes the run code unchanged into the result the model reads.
type Status = ChatTransport['status'];
type ToolOutput = { tool: string; toolCallId: string; output: Record<string, unknown> };
const written: ToolOutput[] = [];
let continuations = 0;
let control: { set(messages: ChatMessage[], status?: Status): void; status(status: Status): void };
let currentStatus: Status = 'ready';

/**
 * Like the bundled transport: writing an outcome puts it into the result and
 * starts the continuation request at once (status `submitted`), except for a
 * page load (`initiated`: the next page continues with `continueTurn`).
 */
function Host({ config }: { config: AiChatProviderConfig & { session?: SessionConfig } }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>('ready');
  currentStatus = status;
  control = { set: (next, nextStatus) => { setMessages(next); if (nextStatus) setStatus(nextStatus); }, status: setStatus };
  const transport = useMemo<ChatTransport>(() => ({
    messages,
    status,
    error: null,
    sendMessage: async () => {},
    stop: () => {},
    setMessages,
    addToolApprovalResponse: () => {},
    addToolOutput: async (value: ToolOutput) => {
      written.push(value);
      setMessages((current) => current.map((message, index) => (index !== current.length - 1 ? message : {
        ...message,
        parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === value.toolCallId
          ? { ...part, output: value.output }
          : part)),
      }) as ChatMessage));
      if ((value.output.outcome as { code?: string } | undefined)?.code !== 'initiated') {
        continuations += 1;
        setStatus('submitted');
      }
    },
    continueTurn: () => { continuations += 1; setStatus('submitted'); },
    setUiOutcomeReporting: () => {},
  }), [messages, status]);
  return <AiChatProvider transport={transport} {...config}><Probe /></AiChatProvider>;
}

const userMessage = (id: string, text = 'Open the tasks') => ({ id, role: 'user', parts: [{ type: 'text', text }] } as ChatMessage);
const user = userMessage('u1');
const uiMessage = (id: string, toolCallId: string, uiAction: unknown = navigate()) => ({
  id,
  role: 'assistant',
  parts: [{ type: 'step-start' }, {
    type: 'tool-ui_navigate', toolCallId, state: 'output-available', input: {}, output: handedOff(uiAction),
  }],
} as unknown as ChatMessage);
const assistant = (toolCallId: string) => uiMessage('a1', toolCallId);
const textMessage = (id: string, text: string) => ({
  id, role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text }],
} as unknown as ChatMessage);
const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function mount(config: AiChatProviderConfig & { session?: SessionConfig } = {}) {
  written.length = 0;
  continuations = 0;
  const bus = new UiActionBus();
  const outcomes: UiActionOutcomeEvent[] = [];
  render(<Host config={{ uiActionBus: bus, onUiActionOutcome: (event) => { outcomes.push(event); }, ...config }} />);
  return { bus, outcomes };
}

/** One request that ends with a step of UI results (the server's `awaitsOutcome` stop). */
async function streamTurn(history: ChatMessage[], answer: ChatMessage) {
  await act(async () => { control.set(history, 'submitted'); });
  await act(async () => { control.set([...history, answer], 'streaming'); });
  await act(async () => { control.status('ready'); });
}

async function runTurn(register: (bus: UiActionBus) => () => void, config: AiChatProviderConfig = {}) {
  const { bus, outcomes } = mount(config);
  cleanups.push(register(bus));
  await streamTurn([user], assistant('c1'));
  await waitFor(() => expect(written).toHaveLength(1), { timeout: 2_000 });
  return { outcome: written[0]!.output.outcome, outcomes };
}

describe('AiChatProvider writes the navigation outcome the model reads', () => {
  it('writes rejected-handler for a bridge whose push returns false', async () => {
    const { outcome } = await runTurn((bus) => registerNavigationBridge({ bus, push: () => false }));
    expect(outcome).toEqual({ v: 1, code: 'rejected-handler' });
  });

  // KNOWN DEFECT (a): end to end, a navigation handler on the bus that declines with `false`
  // is written as `{ v: 1, code: 'ok' }`, which the model reads as "confirmed carried out".
  it.fails('writes rejected-handler for an own navigation handler that returns false', async () => {
    const { outcome } = await runTurn((bus) => bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, declining(() => false)));
    expect(outcome).toEqual({ v: 1, code: 'rejected-handler' });
  });
});

/**
 * A push that asks the user (e.g. unsaved changes) and resolves with the
 * answer: `true` navigated, `false` stayed. The user may take longer than
 * the outcome timeout.
 */
function askingPush() {
  const answers: Array<(navigated: boolean) => void> = [];
  const navigatedTo: string[] = [];
  const push = (href: string) => new Promise<boolean>((resolve) => {
    answers.push((navigated) => { if (navigated) navigatedTo.push(href); resolve(navigated); });
  });
  return { push, answer: (navigated: boolean) => answers.shift()!(navigated), navigatedTo };
}

describe('the outcome timeout (default UI_ACTION_OUTCOME_TIMEOUT_MS = 10 000 ms)', () => {
  it('is set per chat by the provider prop uiActionOutcomeTimeoutMs: a short limit writes "not confirmed"', async () => {
    const dialog = askingPush();
    const run = runTurn((bus) => registerNavigationBridge({ bus, push: dialog.push }), { uiActionOutcomeTimeoutMs: 40 });
    const { outcome, outcomes } = await run;
    expect(outcome).toEqual({ v: 1 });
    expect(outcomes).toEqual([expect.objectContaining({ code: 'timeout' })]);
  });

  it('is set per chat by the provider prop uiActionOutcomeTimeoutMs: a long limit waits for the answer', async () => {
    const dialog = askingPush();
    const { bus } = mount({ uiActionOutcomeTimeoutMs: 5_000 });
    cleanups.push(registerNavigationBridge({ bus, push: dialog.push }));
    await streamTurn([user], assistant('c1'));
    await settle(200); // longer than the short limit above
    expect(written).toEqual([]);
    expect(ctx.isLoading).toBe(true); // the composer stays locked while the chat waits
    await act(async () => { dialog.answer(false); });
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]!.output.outcome).toEqual({ v: 1, code: 'rejected-handler' });
  });

  it('is the timeoutMs option of runToolResultUiActions for an own chat', async () => {
    const bus = new UiActionBus();
    const dialog = askingPush();
    cleanups.push(registerNavigationBridge({ bus, push: dialog.push }));
    const short = await runToolResultUiActions(handedOff(navigate()), bus, { timeoutMs: 20 });
    expect(short).toMatchObject({ code: 'timeout' });
    const long = runToolResultUiActions(handedOff(navigate()), bus, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    dialog.answer(true); // answers the first push (already timed out)
    dialog.answer(true);
    expect(await long).toMatchObject({ code: 'ok' });
  });

  it('has no option on the navigation bridge itself (per bridge or per action)', () => {
    const bus = new UiActionBus();
    // @ts-expect-error NavigationBridgeOptions has push, reloads and bus only
    cleanups.push(registerNavigationBridge({ bus, push: () => undefined, timeoutMs: 60_000 }));
  });
});

describe('a navigation that settles after the outcome timeout', () => {
  it.each([true, false])('drops the late answer (%s): "not confirmed" is written once and the turn goes on', async (navigated) => {
    const dialog = askingPush();
    const { outcome, outcomes } = await runTurn(
      (bus) => registerNavigationBridge({ bus, push: dialog.push }),
      { uiActionOutcomeTimeoutMs: 40 },
    );
    expect(outcome).toEqual({ v: 1 });
    // The continuation request starts at once: the model reads the "not confirmed" text.
    expect(continuations).toBe(1);
    expect(currentStatus).toBe('submitted');
    expect(UI_OUTCOME_MODEL_TEXTS.unconfirmed).toMatch(/it will not be carried out later/);
    await act(async () => { dialog.answer(navigated); });
    await settle(60);
    // Nothing more is written or reported; with `true` the router still navigates.
    expect(written).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(dialog.navigatedTo).toEqual(navigated ? ['/tasks'] : []);
  });

  // KNOWN DEFECT (a): the model was told the navigation "will not be carried out later", but
  // the push already ran, and when the user confirms later the page changes anyway. The late
  // result reaches the SDK (the push promise settles) and is dropped: not even the app's
  // onUiActionOutcome hears of it.
  it.fails('reports the late result of a push that navigated after the timeout', async () => {
    const dialog = askingPush();
    const { outcomes } = await runTurn(
      (bus) => registerNavigationBridge({ bus, push: dialog.push }),
      { uiActionOutcomeTimeoutMs: 40 },
    );
    await act(async () => { dialog.answer(true); });
    await settle(60);
    expect(dialog.navigatedTo).toEqual(['/tasks']);
    expect(outcomes.map((event) => event.code)).toEqual(['timeout', 'ok']);
  });
});

describe('a full page load that does not happen (the page stays after `initiated`)', () => {
  /** Turn 1 asks for a page load; `location.assign` returns and the page stays (beforeunload "Stay"). */
  async function stayAfterPageLoad(extra: AiChatProviderConfig & { session?: SessionConfig } = {}) {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'https://app.example/inbox' });
    const turnEnds: TurnOutcome[] = [];
    const { bus, outcomes } = mount({ onTurnEnd: (outcome) => { turnEnds.push(outcome); }, ...extra });
    cleanups.push(registerDocumentNavigation({ bus }));
    const first = uiMessage('a1', 'c1', navigate('/reports'));
    await streamTurn([user], first);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/reports'));
    await settle(60);
    expect(written.map((entry) => (entry.output.outcome as { code?: string }).code)).toEqual(['initiated']);
    expect(continuations).toBe(0); // the turn waits for a next page that never comes
    return { bus, outcomes, turnEnds, first };
  }

  it('still accepts the next message and saves the history', async () => {
    const saved: ChatMessage[][] = [];
    const { first } = await stayAfterPageLoad({
      session: { load: async () => [], save: (_id: string, messages: ChatMessage[]) => { saved.push(messages); } },
    });
    expect(ctx.canCompose).toBe(true);
    const second = [user, first, userMessage('u2', 'Hello')];
    await act(async () => { control.set(second, 'submitted'); });
    await act(async () => { control.set([...second, textMessage('a2', 'Hi.')], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await settle();
    expect(saved.at(-1)?.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  // KNOWN DEFECT (a): `pageLeavingRef` (ai-chat-provider.tsx) is set on `initiated` and never
  // reset, so the runner skips every later UI action on this page: the handler never runs,
  // no outcome is written, and the next turn waits for it forever.
  it.fails('runs the UI action of the next turn', async () => {
    const { bus, first } = await stayAfterPageLoad();
    const highlight = vi.fn();
    cleanups.push(registerAiClientAction('tasks.highlight', highlight, undefined, { bus }));
    const second = [user, first, userMessage('u2', 'Highlight the task')];
    await streamTurn(second, uiMessage('a2', 'c2', { type: 'glirastes.action', actionId: 'tasks.highlight', payload: {} }));
    await settle(100);
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(written.at(-1)).toMatchObject({ toolCallId: 'c2', output: { outcome: { v: 1, code: 'ok' } } });
  });

  // KNOWN DEFECT (a): the same flag holds every turn-end report on this page: neither the
  // stayed turn nor any later, completed turn reaches onTurnEnd.
  it.fails('reports the next, completed turn to onTurnEnd', async () => {
    const { turnEnds, first } = await stayAfterPageLoad();
    const second = [user, first, userMessage('u2', 'Hello')];
    await act(async () => { control.set(second, 'submitted'); });
    await act(async () => { control.set([...second, textMessage('a2', 'Hi.')], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await settle();
    expect(turnEnds.map((outcome) => outcome.userMessageId)).toContain('u2');
  });

  it('control: without the stayed page load the next turn reaches onTurnEnd and its UI action runs', async () => {
    const turnEnds: TurnOutcome[] = [];
    const { bus } = mount({ onTurnEnd: (outcome) => { turnEnds.push(outcome); } });
    const highlight = vi.fn();
    cleanups.push(registerAiClientAction('tasks.highlight', highlight, undefined, { bus }));
    const history = [userMessage('u2', 'Hello')];
    await act(async () => { control.set(history, 'submitted'); });
    await act(async () => { control.set([...history, textMessage('a2', 'Hi.')], 'streaming'); });
    await act(async () => { control.status('ready'); });
    await settle();
    expect(turnEnds.map((outcome) => outcome.userMessageId)).toEqual(['u2']);
    const next = [...history, textMessage('a2', 'Hi.'), userMessage('u3', 'Highlight the task')];
    await streamTurn(next, uiMessage('a3', 'c3', { type: 'glirastes.action', actionId: 'tasks.highlight', payload: {} }));
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1));
  });
});
