import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  dispatchToolResultUiActions,
  GLIRASTES_NAVIGATE_ACTION_ID,
  isUiActionRejectedError,
  registerAiClientAction,
  registerDocumentNavigation,
  registerNavigationBridge,
  runToolResultUiActions,
  toolResultUiActions,
  UI_ACTION_OUTCOME_TIMEOUT_MS,
  UI_ACTION_REJECTED_ERROR_CODE,
  UiActionBus,
  UiActionRejectedError,
} from '../index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

const navigate = (href = '/tasks') => ({
  type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href },
});
const action = (actionId: string, extra: Record<string, unknown> = {}) => ({
  type: 'glirastes.action', actionId, payload: {}, ...extra,
});
const result = (uiAction: unknown) => ({ success: true, message: 'Handed to the app.', uiAction });

describe('UiActionBus.dispatch', () => {
  it('returns how many handlers ran', async () => {
    const bus = new UiActionBus();
    expect(await bus.dispatch(navigate())).toBe(0);
    cleanups.push(bus.subscribeByType('glirastes.navigate', () => {}));
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, () => {}));
    expect(await bus.dispatch(navigate())).toBe(2);
  });
});

describe('UiActionRejectedError', () => {
  it('carries a stable code and the reason, and keeps the message', () => {
    const error = new UiActionRejectedError('handler', 'UI action x was not executed');
    expect(error.code).toBe(UI_ACTION_REJECTED_ERROR_CODE);
    expect(error.code).toBe('glirastes.ui-action-rejected');
    expect(error.reason).toBe('handler');
    expect(error.message).toBe('UI action x was not executed');
    expect(error).toBeInstanceOf(Error);
  });

  it('is recognised by its code, also from another SDK copy', () => {
    expect(isUiActionRejectedError({ code: 'glirastes.ui-action-rejected', reason: 'contract' })).toBe(true);
    expect(isUiActionRejectedError({ code: 'glirastes.ui-action-rejected', reason: 'other' })).toBe(false);
    expect(isUiActionRejectedError(new Error('UI action x was not executed'))).toBe(false);
  });

  it('is what registerAiClientAction throws, with the same messages as before', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerAiClientAction('tasks.highlight', () => {}, z.object({ taskId: z.string() }), { bus }));
    cleanups.push(registerAiClientAction('dialogs.open', () => false, undefined, { bus }));
    const contract = await bus.dispatch(action('tasks.highlight', { payload: { taskId: 2 } })).catch((error: unknown) => error);
    expect(isUiActionRejectedError(contract) && contract.reason).toBe('contract');
    expect((contract as Error).message).toBe('Invalid payload for UI action tasks.highlight');
    const handler = await bus.dispatch(action('dialogs.open')).catch((error: unknown) => error);
    expect(isUiActionRejectedError(handler) && handler.reason).toBe('handler');
    expect((handler as Error).message).toBe('UI action dialogs.open was not executed');
  });
});

describe('runToolResultUiActions', () => {
  it('returns null when the result has no Glirastes UI action to run', async () => {
    const bus = new UiActionBus();
    expect(await runToolResultUiActions({ success: false, uiAction: navigate() }, bus)).toBeNull();
    expect(await runToolResultUiActions(result({ type: 'set-filters' }), bus)).toBeNull();
    expect(await runToolResultUiActions('text', bus)).toBeNull();
  });

  it('reports ok when every handler resolved', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    const run = await runToolResultUiActions(result(navigate('/tasks?status=done')), bus);
    expect(run).toMatchObject({ code: 'ok', dispatched: 1 });
    expect(run!.durationMs).toBeGreaterThanOrEqual(0);
    expect(push).toHaveBeenCalledWith('/tasks?status=done');
  });

  it('classifies a contract failure, a declining handler and a throwing handler', async () => {
    const bus = new UiActionBus();
    const boom = new Error('boom');
    cleanups.push(registerAiClientAction('tasks.highlight', () => {}, z.object({ taskId: z.string() }), { bus }));
    cleanups.push(registerAiClientAction('dialogs.open', () => false, undefined, { bus }));
    cleanups.push(registerAiClientAction('dialogs.crash', () => { throw boom; }, undefined, { bus }));
    expect(await runToolResultUiActions(result(action('tasks.highlight', { payload: { taskId: 1 } })), bus))
      .toMatchObject({ code: 'rejected-contract', dispatched: 0 });
    expect(await runToolResultUiActions(result(action('dialogs.open')), bus))
      .toMatchObject({ code: 'rejected-handler', dispatched: 0 });
    const crashed = await runToolResultUiActions(result(action('dialogs.crash')), bus);
    expect(crashed).toMatchObject({ code: 'failed', dispatched: 0 });
    expect(crashed!.error).toBe(boom);
  });

  it('reads the reason of a rejection thrown by another SDK copy by its code', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById('dialogs.open', () => {
      throw Object.assign(new Error('declined'), { code: 'glirastes.ui-action-rejected', reason: 'handler' });
    }));
    expect(await runToolResultUiActions(result(action('dialogs.open')), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports unavailable when no handler runs the action (navigation without a bridge)', async () => {
    const bus = new UiActionBus();
    expect(await runToolResultUiActions(result(navigate()), bus)).toMatchObject({ code: 'unavailable', dispatched: 0 });
  });

  it('reports unavailable for a routed action whose handler never registers on its page', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push }));
    const run = await runToolResultUiActions(
      result(action('template-create-dialog.open', { route: '/templates' })),
      bus,
      { routeTimeoutMs: 20 },
    );
    expect(push).toHaveBeenCalledWith('/templates');
    expect(run).toMatchObject({ code: 'unavailable', dispatched: 0 });
  });

  it('reports unavailable at once for a routed action when nothing can navigate', async () => {
    const bus = new UiActionBus();
    const started = Date.now();
    const run = await runToolResultUiActions(
      result(action('template-create-dialog.open', { route: '/templates' })),
      bus,
      { routeTimeoutMs: 5_000 },
    );
    expect(run).toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('runs a routed action once its page registered it', async () => {
    const bus = new UiActionBus();
    const handler = vi.fn();
    cleanups.push(registerNavigationBridge({
      bus,
      push: () => {
        setTimeout(() => cleanups.push(registerAiClientAction('template-create-dialog.open', handler, undefined, { bus })), 10);
      },
    }));
    expect(await runToolResultUiActions(result(action('template-create-dialog.open', { route: '/templates' })), bus))
      .toMatchObject({ code: 'ok', dispatched: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a routed action with an unsafe route as rejected-contract', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: vi.fn() }));
    expect(await runToolResultUiActions(result(action('x.open', { route: '//evil.example' })), bus))
      .toMatchObject({ code: 'rejected-contract' });
  });

  it('reports timeout when a handler does not settle in time and runs nothing after it', async () => {
    expect(UI_ACTION_OUTCOME_TIMEOUT_MS).toBe(10_000);
    const bus = new UiActionBus();
    const later = vi.fn();
    cleanups.push(bus.subscribeById('dialogs.open', () => new Promise<void>(() => {})));
    cleanups.push(bus.subscribeById('toast.show', later));
    const run = await runToolResultUiActions(result([action('dialogs.open'), action('toast.show')]), bus, { timeoutMs: 20 });
    expect(run).toMatchObject({ code: 'timeout', dispatched: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(later).not.toHaveBeenCalled();
  });

  it('gives a routed action the route wait on top of the outcome timeout', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({
      bus,
      push: () => {
        setTimeout(() => cleanups.push(registerAiClientAction('x.open', () => {}, undefined, { bus })), 40);
      },
    }));
    expect(await runToolResultUiActions(result(action('x.open', { route: '/x' })), bus, { timeoutMs: 20, routeTimeoutMs: 200 }))
      .toMatchObject({ code: 'ok' });
  });

  it('never reports ok for a bus of an older SDK copy that does not count handlers', async () => {
    const real = new UiActionBus();
    const foreign = {
      dispatch: async (uiAction: Parameters<UiActionBus['dispatch']>[0]) => { await real.dispatch(uiAction); },
      subscribeById: real.subscribeById.bind(real),
      subscribeByType: real.subscribeByType.bind(real),
    } as unknown as UiActionBus;
    cleanups.push(registerNavigationBridge({ bus: foreign, push: vi.fn() }));
    expect(await runToolResultUiActions(result(navigate()), foreign)).toMatchObject({ code: 'unconfirmed', dispatched: 1 });
  });

  it('reports initiated on a bus of an older SDK copy and runs nothing after it', async () => {
    const real = new UiActionBus();
    const foreign = {
      dispatch: async (uiAction: Parameters<UiActionBus['dispatch']>[0]) => { await real.dispatch(uiAction); },
      subscribeById: real.subscribeById.bind(real),
      subscribeByType: real.subscribeByType.bind(real),
    } as unknown as UiActionBus;
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const after = vi.fn();
    cleanups.push(registerDocumentNavigation({ bus: foreign }));
    cleanups.push(foreign.subscribeById('toast.show', after));
    expect(await runToolResultUiActions(result([navigate('/reports'), action('toast.show')]), foreign))
      .toMatchObject({ code: 'initiated', dispatched: 1 });
    expect(after).not.toHaveBeenCalled();
  });

  it('stops before the next action once its signal aborts', async () => {
    const bus = new UiActionBus();
    const controller = new AbortController();
    const second = vi.fn();
    cleanups.push(bus.subscribeById('first', () => { controller.abort(); }));
    cleanups.push(bus.subscribeById('second', second));
    expect(await runToolResultUiActions(result([action('first'), action('second')]), bus, { signal: controller.signal }))
      .toMatchObject({ code: 'unconfirmed', dispatched: 1 });
    expect(second).not.toHaveBeenCalled();
  });

  it('returns unconfirmed at once when its signal aborts while a handler is pending', async () => {
    vi.useFakeTimers();
    try {
      const bus = new UiActionBus();
      const controller = new AbortController();
      const second = vi.fn();
      let settled = false;
      // A handler that waits 5 s (an app dialog), far below the 10 s outcome timeout.
      cleanups.push(bus.subscribeById('first', () => new Promise<void>((resolve) => { setTimeout(resolve, 5_000); })));
      cleanups.push(bus.subscribeById('second', second));
      const run = runToolResultUiActions(result([action('first'), action('second')]), bus, { signal: controller.signal })
        .then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await run).toMatchObject({ code: 'unconfirmed', dispatched: 0 });
      // The handler settles later: nothing after it runs.
      await vi.advanceTimersByTimeAsync(UI_ACTION_OUTCOME_TIMEOUT_MS);
      expect(second).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a result array at the first failure and reports its code', async () => {
    const bus = new UiActionBus();
    const first = vi.fn();
    const third = vi.fn();
    cleanups.push(bus.subscribeById('toast.show', first));
    cleanups.push(registerAiClientAction('dialogs.open', () => false, undefined, { bus }));
    cleanups.push(bus.subscribeById('list.refresh', third));
    const run = await runToolResultUiActions(
      result([action('toast.show'), action('dialogs.open'), action('list.refresh')]),
      bus,
    );
    expect(run).toMatchObject({ code: 'rejected-handler', dispatched: 1 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
  });

  it('leaves dispatchToolResultUiActions throwing as before', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerAiClientAction('dialogs.open', () => false, undefined, { bus }));
    await expect(dispatchToolResultUiActions(result(action('dialogs.open')), bus)).rejects.toThrow('UI action dialogs.open was not executed');
    expect(await dispatchToolResultUiActions(result(navigate()), bus)).toBe(1);
  });
});

describe('navigation bridge outcomes', () => {
  it('treats a void push (Next.js router) as ok', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: () => undefined }));
    expect(await runToolResultUiActions(result(navigate()), bus)).toMatchObject({ code: 'ok' });
  });

  it('treats push returning false as declined (vue-router navigation failure)', async () => {
    const bus = new UiActionBus();
    // vue-router resolves a failed navigation with a NavigationFailure instead of throwing.
    const router = { push: async (_href: string) => ({ type: 4, message: 'Navigation aborted' }) as unknown };
    cleanups.push(registerNavigationBridge({ bus, push: async (href) => !(await router.push(href)) }));
    const run = await runToolResultUiActions(result(navigate()), bus);
    expect(run).toMatchObject({ code: 'rejected-handler' });
    expect(isUiActionRejectedError(run!.error)).toBe(true);

    const ok = new UiActionBus();
    const succeeding = { push: async (_href: string) => undefined };
    cleanups.push(registerNavigationBridge({ bus: ok, push: async (href) => !(await succeeding.push(href)) }));
    expect(await runToolResultUiActions(result(navigate()), ok)).toMatchObject({ code: 'ok' });
  });

  it('reports an unsafe target as rejected-contract with the old message', async () => {
    const bus = new UiActionBus();
    cleanups.push(registerNavigationBridge({ bus, push: vi.fn() }));
    const run = await runToolResultUiActions(result(navigate('https://evil.example')), bus);
    expect(run).toMatchObject({ code: 'rejected-contract' });
    expect((run!.error as Error).message).toBe('Unsafe navigation target');
  });

  it('reports initiated for a reloading navigation and runs nothing after it', async () => {
    const bus = new UiActionBus();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const after = vi.fn();
    cleanups.push(registerDocumentNavigation({ bus }));
    cleanups.push(bus.subscribeById('toast.show', after));
    const run = await runToolResultUiActions(result([navigate('/reports'), action('toast.show')]), bus);
    expect(assign).toHaveBeenCalledWith('/reports');
    expect(run).toMatchObject({ code: 'initiated', dispatched: 1 });
    expect(after).not.toHaveBeenCalled();
  });

  it('treats a fragment change on the open page as carried out, not as a page load', async () => {
    const bus = new UiActionBus();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'https://app.example/tasks?view=list' });
    const after = vi.fn();
    cleanups.push(registerDocumentNavigation({ bus }));
    cleanups.push(bus.subscribeById('toast.show', after));
    expect(await runToolResultUiActions(result([navigate('/tasks?view=list#details'), action('toast.show')]), bus))
      .toMatchObject({ code: 'ok', dispatched: 2 });
    expect(after).toHaveBeenCalledTimes(1);
    expect(await runToolResultUiActions(result(navigate('/reports#top')), bus)).toMatchObject({ code: 'initiated' });
  });

  it('reports initiated for an own bridge that reloads', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ bus, push, reloads: true }));
    expect(await runToolResultUiActions(result(navigate()), bus)).toMatchObject({ code: 'initiated' });
    expect(push).toHaveBeenCalledWith('/tasks');
  });

  it('does not report initiated when a reloading bridge refuses an unsafe target', async () => {
    const bus = new UiActionBus();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    cleanups.push(registerDocumentNavigation({ bus }));
    expect(await runToolResultUiActions(result(navigate('//evil.example')), bus)).toMatchObject({ code: 'rejected-contract' });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the hand-off shape of 0.18 (handedOff instead of success)', () => {
  const handedOff = (uiAction: unknown, extra: Record<string, unknown> = {}) => ({
    handedOff: true, message: 'Handed to the app.', uiAction, ...extra,
  });

  it('runs and dispatches its Glirastes actions like a successful result', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ push, bus }));
    expect(toolResultUiActions(handedOff(navigate()))).toHaveLength(1);
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'ok', dispatched: 1 });
    expect(await dispatchToolResultUiActions(handedOff(navigate()), bus)).toBe(1);
    expect(push).toHaveBeenCalledTimes(2);
    // Neither handed off nor successful: nothing runs.
    expect(toolResultUiActions({ message: 'x', uiAction: navigate() })).toEqual([]);
    expect(toolResultUiActions({ success: false, handedOff: false, uiAction: navigate() })).toEqual([]);
  });

  it("runs the app's own actions only of a result the server marked for the outcome protocol", async () => {
    const own = { type: 'open-dialog', dialog: 'delete' };
    expect(toolResultUiActions(handedOff(own))).toEqual([]);
    expect(toolResultUiActions(handedOff(own, { awaitsOutcome: true }))).toEqual([own]);
    expect(toolResultUiActions(handedOff([own, navigate()], { awaitsOutcome: false }))).toEqual([own, navigate()]);
    const bus = new UiActionBus();
    expect(await runToolResultUiActions(handedOff(own, { awaitsOutcome: true }), bus)).toMatchObject({ code: 'unavailable' });
    cleanups.push(bus.subscribeByType('open-dialog', () => {}));
    expect(await runToolResultUiActions(handedOff(own, { awaitsOutcome: true }), bus)).toMatchObject({ code: 'ok' });
  });
});
