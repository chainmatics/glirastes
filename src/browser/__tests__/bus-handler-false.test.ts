/**
 * #179: a handler subscribed directly on the bus (`subscribeById`,
 * `subscribeByType`, and the React hooks `useAiClientActionById` /
 * `useAiClientActionByType` that map to them) that returns `false`, sync or
 * async, declined the action: the outcome is `rejected-handler`, not `ok`.
 * `true` and `undefined` stay `ok`. Cases taken over from the repro branch
 * `test/navigation-action-outcome` (c158d57b).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchToolResultUiActions,
  GLIRASTES_NAVIGATE_ACTION_ID,
  isUiActionRejectedError,
  runToolResultUiActions,
  UiActionBus,
  type UiActionHandler,
} from '../index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});

const navigate = (href = '/tasks') => ({
  type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href },
});
const handedOff = (uiAction: unknown) => ({ handedOff: true, message: 'Handed to the app.', uiAction, awaitsOutcome: true });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a bus handler that returns false (#179)', () => {
  it('reports rejected-handler when a handler subscribed by id returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, () => false));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler', dispatched: 0 });
  });

  it('reports rejected-handler when a handler subscribed by type returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeByType('glirastes.navigate', () => false));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports rejected-handler when an async bus handler resolves false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, async () => { await tick(); return false; }));
    expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'rejected-handler' });
  });

  it('reports rejected-handler for an opted-in own action whose type handler returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeByType('app.navigate', () => false));
    const run = await runToolResultUiActions(handedOff({ type: 'app.navigate', path: '/tasks' }), bus);
    expect(run).toMatchObject({ code: 'rejected-handler' });
  });

  it('keeps ok for a handler that returns true or nothing, sync or async', async () => {
    const handlers: UiActionHandler[] = [() => true, () => undefined, async () => true, async () => {}];
    for (const handler of handlers) {
      const bus = new UiActionBus();
      cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, handler));
      expect(await runToolResultUiActions(handedOff(navigate()), bus)).toMatchObject({ code: 'ok', dispatched: 1 });
    }
  });

  it('stops the handlers after the one that declined, as after one that throws', async () => {
    const bus = new UiActionBus();
    const after = vi.fn();
    cleanups.push(bus.subscribeByType('glirastes.navigate', () => false));
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, after));
    await expect(bus.dispatch(navigate())).rejects.toSatisfy(
      (error: unknown) => isUiActionRejectedError(error) && error.reason === 'handler',
    );
    expect(after).not.toHaveBeenCalled();
  });

  it('makes dispatchToolResultUiActions reject as for a client action that returns false', async () => {
    const bus = new UiActionBus();
    cleanups.push(bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, () => false));
    await expect(dispatchToolResultUiActions({ success: true, uiAction: navigate() }, bus)).rejects.toSatisfy(
      (error: unknown) => isUiActionRejectedError(error) && error.reason === 'handler',
    );
  });
});
