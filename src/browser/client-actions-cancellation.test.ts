import { describe, expect, it, vi } from 'vitest';
import { dispatchToolResultUiActions, registerAiClientAction } from './client-actions.js';
import { UiActionBus } from './ui-action-bus.js';
import { GLIRASTES_NAVIGATE_ACTION_ID } from './navigation.js';

describe('origin session cancellation during navigation', () => {
  it('never executes a route handler when navigation synchronously cancels the originating session', async () => {
    const bus = new UiActionBus();
    const session = new AbortController();
    const handler = vi.fn(() => true);
    bus.subscribeById(GLIRASTES_NAVIGATE_ACTION_ID, () => {
      session.abort();
      registerAiClientAction('highlight', handler, undefined, { bus });
    });
    await expect(dispatchToolResultUiActions({ success: true, uiAction: {
      type: 'glirastes.action', actionId: 'highlight', route: '/jobs', payload: { id: 'job-107' },
    } }, bus, { signal: session.signal })).rejects.toMatchObject({ status: 'cancelled' });
    expect(handler).not.toHaveBeenCalled();
  });
});
