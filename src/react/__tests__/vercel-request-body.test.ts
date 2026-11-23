import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultUiActionBus } from '../../browser/ui-action-bus.js';
import { chatRequestBody, chatRequestHeaders } from '../transports/vercel.js';

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

describe('chat request headers', () => {
  it('resolves an async headers function and adds Content-Language', async () => {
    await expect(
      chatRequestHeaders(async () => ({ Authorization: 'Bearer t' }), 'de'),
    ).resolves.toEqual({ Authorization: 'Bearer t', 'content-language': 'de' });
  });

  it('keeps a host Content-Language from an async function', async () => {
    await expect(
      chatRequestHeaders(async () => ({ 'content-language': 'fr' }), 'de'),
    ).resolves.toEqual({ 'content-language': 'fr' });
  });

  it('rejects when the async headers function rejects', async () => {
    await expect(
      chatRequestHeaders(async () => { throw new Error('no ticket'); }, 'de'),
    ).rejects.toThrow('no ticket');
  });

  it('keeps sync headers synchronous', () => {
    expect(chatRequestHeaders({ A: 'b' }, 'de')).toEqual({ A: 'b', 'content-language': 'de' });
  });
});
