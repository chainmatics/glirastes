import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildNavigationHref,
  defineQueryFilters,
  dispatchToolResultUiActions,
  getDefaultUiActionBus,
  GLIRASTES_NAVIGATE_ACTION_ID,
  isSafeAppHref,
  registerAiClientAction,
  registerNavigationBridge,
  UiActionBus,
} from '../index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('UiActionBus', () => {
  it('dispatches by type and by id and stops after unsubscribe', async () => {
    const bus = new UiActionBus();
    const byType = vi.fn();
    const byId = vi.fn();
    bus.subscribeByType('glirastes.action', byType);
    const off = bus.subscribeById('tasks.highlight', byId);
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    off();
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight' });
    expect(byType).toHaveBeenCalledTimes(2);
    expect(byId).toHaveBeenCalledTimes(1);
  });

  it('shares one default bus per page, even across duplicated module copies', () => {
    expect(getDefaultUiActionBus()).toBe(getDefaultUiActionBus());
    const key = Symbol.for('glirastes.uiActionBus');
    expect((globalThis as Record<symbol, unknown>)[key]).toBe(getDefaultUiActionBus());
  });

  it('keeps the bus another SDK copy registered instead of replacing it', () => {
    const key = Symbol.for('glirastes.uiActionBus');
    const scope = globalThis as Record<symbol, unknown>;
    const previous = scope[key];
    const foreign = { dispatch: async () => {}, subscribeById: () => () => {}, subscribeByType: () => () => {} };
    scope[key] = foreign;
    try {
      expect(getDefaultUiActionBus()).toBe(foreign);
    } finally {
      scope[key] = previous;
    }
  });
});

describe('registerAiClientAction', () => {
  it('validates the payload with the contract before the handler runs', async () => {
    const bus = new UiActionBus();
    const handler = vi.fn();
    cleanups.push(registerAiClientAction('tasks.highlight', handler, z.object({ taskId: z.string() }).strict(), { bus }));
    await bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } });
    await expect(bus.dispatch({ type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: 2 } }))
      .rejects.toThrow('Invalid payload for UI action tasks.highlight');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ taskId: '2' });
  });

  it('registers on the default bus when none is given', async () => {
    const handler = vi.fn();
    cleanups.push(registerAiClientAction('dialogs.open', handler));
    await getDefaultUiActionBus().dispatch({ type: 'glirastes.action', actionId: 'dialogs.open', payload: { id: 'x' } });
    expect(handler).toHaveBeenCalledWith({ id: 'x' });
  });
});

describe('navigation bridge', () => {
  it('pushes the href that the navigation tool computed', async () => {
    const bus = new UiActionBus();
    const push = vi.fn();
    cleanups.push(registerNavigationBridge({ push, bus }));
    await bus.dispatch({
      type: 'glirastes.navigate',
      actionId: GLIRASTES_NAVIGATE_ACTION_ID,
      payload: { href: '/tasks?status=done', destination: '/tasks' },
    });
    expect(push).toHaveBeenCalledWith('/tasks?status=done');
  });

  it.each([
    'https://evil.example/', '//evil.example/x', '/\\evil', 'javascript:alert(1)', '', '/tasks\n',
    '/tasks/..//evil.example', '/a/%2E%2E//evil.example',
  ])(
    'never navigates to %j',
    async (href) => {
      const bus = new UiActionBus();
      const push = vi.fn();
      cleanups.push(registerNavigationBridge({ push, bus }));
      await expect(bus.dispatch({ type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href } }))
        .rejects.toThrow('Unsafe navigation target');
      expect(push).not.toHaveBeenCalled();
      expect(isSafeAppHref(href)).toBe(false);
    },
  );
});

describe('buildNavigationHref', () => {
  it('fills route parameters and encodes query values in key order', () => {
    expect(buildNavigationHref({
      destination: '/projects/:projectId/tasks',
      params: { projectId: 'a b' },
      query: { status: 'done', page: 2, archived: false, tags: ['x', 'y'], ids: ['1', '2'], empty: undefined },
      arrayFormats: { tags: 'comma', ids: 'repeat' },
    })).toBe('/projects/a%20b/tasks?status=done&page=2&archived=false&tags=x%2Cy&ids=1&ids=2');
  });

  it('refuses a destination with a missing parameter or a parameter that moves the path', () => {
    expect(() => buildNavigationHref({ destination: '/tasks/:id' })).toThrow('Missing route parameter id');
    expect(() => buildNavigationHref({ destination: '/tasks/:id', params: { id: '..' } }))
      .toThrow('Invalid route parameter id');
    expect(buildNavigationHref({ destination: '/tasks/:id', params: { id: '../admin' } })).toBe('/tasks/..%2Fadmin');
  });
});

describe('dispatchToolResultUiActions', () => {
  it('dispatches only Glirastes UI actions of successful tool results', async () => {
    const bus = new UiActionBus();
    const seen = vi.fn();
    bus.subscribeByType('glirastes.navigate', seen);
    bus.subscribeByType('set-filters', seen);
    expect(await dispatchToolResultUiActions({
      success: true,
      uiAction: [
        { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/tasks' } },
        { type: 'set-filters', filters: {} },
      ],
    }, bus)).toBe(1);
    expect(await dispatchToolResultUiActions({ success: false, uiAction: { type: 'glirastes.navigate' } }, bus)).toBe(0);
    expect(await dispatchToolResultUiActions('not a result', bus)).toBe(0);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('defineQueryFilters', () => {
  const tasks = defineQueryFilters({
    path: '/tasks',
    filters: {
      status: ['open', 'done'],
      q: 'string',
      page: 'integer',
      archived: 'boolean',
      tags: { arrayOf: 'string', format: 'comma' },
    },
  });

  it('reads typed values from a query string and drops values outside the domain', () => {
    expect(tasks.read('?status=done&q=release&page=2&archived=true&tags=a,b')).toEqual({
      status: 'done', q: 'release', page: 2, archived: true, tags: ['a', 'b'],
    });
    expect(tasks.read(new URLSearchParams('status=blocked&page=two'))).toEqual({});
  });

  it('builds the href the filter tool pushes', () => {
    expect(tasks.href({ status: 'open', tags: ['a', 'b'] })).toBe('/tasks?status=open&tags=a%2Cb');
  });

  it.each([
    ['a relative path', { path: 'tasks', filters: {} }],
    ['an empty enum', { path: '/tasks', filters: { status: [] } }],
    ['an unknown kind', { path: '/tasks', filters: { status: 'date' } }],
    ['a key that is not a name', { path: '/tasks', filters: { 'a b': 'string' } }],
  ])('rejects %s', (_label, definition) => {
    expect(() => defineQueryFilters(definition as never)).toThrow();
  });
});
