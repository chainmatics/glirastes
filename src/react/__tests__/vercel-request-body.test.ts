import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultUiActionBus } from '../../browser/ui-action-bus.js';
import { chatRequestBody } from '../transports/vercel.js';

const unsubscribes: Array<() => void> = [];
afterEach(() => unsubscribes.splice(0).forEach((stop) => stop()));

describe('chat request body', () => {
  it('reports the client actions the open page handles, next to the host extras', () => {
    unsubscribes.push(getDefaultUiActionBus().subscribeById('task-details.open', () => {}));
    expect(chatRequestBody(() => ({ sessionId: 's1' }))).toEqual({
      glirastesClientActions: ['task-details.open'],
      sessionId: 's1',
    });
    expect(chatRequestBody(undefined)).toEqual({ glirastesClientActions: ['task-details.open'] });
  });
});
