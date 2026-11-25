import { afterEach, describe, expect, it, vi } from 'vitest';
import { VIEW_CONTEXT_LIMITS, ViewContextSchema, type ViewContextEntry } from '../../contracts/view-context.js';
import { currentViewContext, registerViewContext } from '../index.js';
import { viewContextRequestBody, viewContextState, VIEW_CONTEXT_REQUEST_FIELD } from '../view-context-store.js';
import { VIEW_CONTEXT_FIELD, VIEW_CONTEXT_WIRE_VERSION } from '../../server/adapters/nextjs/view-context-block.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(currentViewContext()).toEqual([]);
});

const order = (id: string, extra: Partial<ViewContextEntry> = {}): ViewContextEntry =>
  ({ entity: { type: 'order', id }, ...extra }) as ViewContextEntry;

function register(source: string, entry: ViewContextEntry | null) {
  const off = registerViewContext(source, entry);
  cleanups.push(off);
  return off;
}

describe('registerViewContext', () => {
  it('is empty until an app registers something', () => {
    expect(currentViewContext()).toEqual([]);
    expect(viewContextRequestBody()).toBeUndefined();
  });

  it('registers, updates in place and unregisters per source', () => {
    register('page', order('o-1', { label: 'Order 1' }));
    register('panel', { selection: { type: 'line', ids: ['l-1', 'l-2'] } });
    expect(currentViewContext()).toEqual([
      { entity: { type: 'order', id: 'o-1' }, label: 'Order 1' },
      { selection: { type: 'line', ids: ['l-1', 'l-2'] } },
    ]);
    // An update keeps the place of its source.
    register('page', order('o-2'));
    expect(currentViewContext().map((entry) => entry.entity?.id ?? entry.selection?.type)).toEqual(['o-2', 'line']);
    // `null` unregisters.
    register('page', null);
    expect(currentViewContext()).toEqual([{ selection: { type: 'line', ids: ['l-1', 'l-2'] } }]);
  });

  it('keeps registration order, deterministic, and drops duplicates after the first', () => {
    register('b', order('o-2'));
    register('a', order('o-1'));
    register('c', order('o-2', { label: 'again' }));
    expect(currentViewContext()).toEqual([order('o-2'), order('o-1')]);
  });

  it('an unregister only removes its own registration (StrictMode and re-registration)', () => {
    const first = registerViewContext('page', order('o-1'));
    const second = registerViewContext('page', order('o-2'));
    cleanups.push(second);
    first();
    expect(currentViewContext()).toEqual([order('o-2')]);
    second();
    second();
    expect(currentViewContext()).toEqual([]);
  });

  it('bounds the snapshot with the contract limits', () => {
    for (let index = 0; index < VIEW_CONTEXT_LIMITS.maxEntries + 3; index += 1) register(`s${index}`, order(`o-${index}`));
    const ids = Array.from({ length: 80 }, (_, index) => `l-${index}`);
    register('list', { selection: { type: 'line', ids } });
    const snapshot = currentViewContext();
    expect(snapshot).toHaveLength(VIEW_CONTEXT_LIMITS.maxEntries);
    expect(snapshot.map((entry) => entry.entity?.id)).toEqual(Array.from({ length: 8 }, (_, index) => `o-${index}`));
    cleanups.splice(0).forEach((off) => off());
    register('list', { selection: { type: 'line', ids } });
    expect(currentViewContext()[0]!.selection!.ids).toHaveLength(VIEW_CONTEXT_LIMITS.maxSelectionIds);
  });

  it('cleans defensively with the contract: label cut, invalid route and id dropped, facts bounded', () => {
    register('page', order('o-1', {
      label: `Order ${'x'.repeat(100)}`,
      route: '/orders/o-1?tab=lines',
      unsaved: true,
      facts: { status: 'open', note: 'a​b' },
    }));
    register('bad-id', order(' o-2 '));
    register('bad', { label: 'nothing' } as unknown as ViewContextEntry);
    const [entry, ...rest] = currentViewContext();
    expect(rest).toEqual([]);
    expect([...entry!.label!].length).toBe(VIEW_CONTEXT_LIMITS.maxLabelLength);
    expect(entry!.label!.endsWith('…')).toBe(true);
    expect(entry).not.toHaveProperty('route');
    expect(entry!.unsaved).toBe(true);
    // Facts are sent (the server checks them against its schema), cleaned as the server would.
    expect(entry!.facts).toEqual({ status: 'open', note: 'ab' });
    // What the browser sends is a sanitized view context.
    expect(ViewContextSchema.safeParse(currentViewContext()).success).toBe(true);
  });

  it('returns an own copy: a later change of the registered object or the snapshot changes nothing', () => {
    const facts: Record<string, unknown> = { status: 'open' };
    const entry = { entity: { type: 'order', id: ['o', 1] }, facts } as unknown as ViewContextEntry;
    register('page', entry);
    const snapshot = currentViewContext();
    facts.status = 'closed';
    (snapshot[0]!.entity!.id as Array<string | number>).push('x');
    expect(snapshot[0]!.facts).toEqual({ status: 'open' });
    expect(currentViewContext()[0]!.entity!.id).toEqual(['o', 1]);
  });

  it('never throws on hostile input; the snapshot fails closed', () => {
    const hostile = { get entity(): never { throw new Error('boom'); } } as unknown as ViewContextEntry;
    register('hostile', hostile);
    register('page', order('o-1'));
    expect(() => currentViewContext()).not.toThrow();
    expect(currentViewContext()).toEqual([order('o-1')]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    register('cyclic', order('o-2', { facts: cyclic as never }));
    expect(() => currentViewContext()).not.toThrow();
  });

  it('refuses a source that is not a non-empty string', () => {
    expect(() => registerViewContext('', order('o-1'))).toThrow(TypeError);
    expect(() => registerViewContext(1 as unknown as string, order('o-1'))).toThrow(TypeError);
  });

  it('shares one registry between copies of the SDK on a page', () => {
    register('page', order('o-1'));
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('glirastes.viewContext')];
    expect(registry).toBe(viewContextState());
  });

  it('an entry unregistered with null comes last when registered again', () => {
    register('a', order('o-1'));
    register('b', order('o-2'));
    register('a', null);
    register('a', order('o-1'));
    expect(currentViewContext()).toEqual([order('o-2'), order('o-1')]);
  });
});

describe('the request body field', () => {
  it('reading it for a send creates no global state on a page that never registered anything', () => {
    const key = Symbol.for('glirastes.viewContext');
    const scope = globalThis as Record<symbol, unknown>;
    const saved = scope[key];
    delete scope[key];
    try {
      expect(viewContextRequestBody()).toBeUndefined();
      expect(key in scope).toBe(false);
    } finally {
      if (saved !== undefined) scope[key] = saved;
    }
  });

  it('fails closed: an entry without the cleaning snapshot is not sent', () => {
    const state = viewContextState();
    const saved = state.snapshot;
    state.snapshot = undefined;
    state.entries.set('raw', { token: {}, entry: order('o-1') });
    try {
      expect(viewContextRequestBody()).toBeUndefined();
      state.snapshot = () => { throw new Error('boom'); };
      expect(viewContextRequestBody()).toBeUndefined();
    } finally {
      state.entries.delete('raw');
      state.snapshot = saved;
    }
  });

  it('is the field and version the server reads, with the current snapshot', () => {
    expect(VIEW_CONTEXT_REQUEST_FIELD).toBe(VIEW_CONTEXT_FIELD);
    register('page', order('o-1'));
    expect(viewContextRequestBody()).toEqual({
      [VIEW_CONTEXT_FIELD]: { version: VIEW_CONTEXT_WIRE_VERSION, current: [order('o-1')] },
    });
  });

  it('sends no field when every registered entry is dropped', () => {
    register('bad', { label: 'nothing' } as unknown as ViewContextEntry);
    expect(viewContextRequestBody()).toBeUndefined();
  });

  it('never carries byMessage (reserved)', () => {
    register('page', order('o-1'));
    expect(viewContextRequestBody()![VIEW_CONTEXT_REQUEST_FIELD]).not.toHaveProperty('byMessage');
  });
});

describe('development warnings', () => {
  it('names the source and reason once, never a value, and only in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');
    try {
      for (let index = 0; index < 8; index += 1) register(`s${index}`, order(`o-${index}`));
      register('ninth', order('secret-9'));
      register('broken', { entity: { type: 'order', id: ' secret ' } } as ViewContextEntry);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      register('cyclic', order('o-c', { facts: cyclic as never }));
      register('s0', order('o-0', { facts: { note: 'secret'.repeat(500) } }));
      currentViewContext();
      currentViewContext();
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([
        '[glirastes] View context of "s0" not sent as registered: facts-too-large',
        '[glirastes] View context of "ninth" not sent as registered: over-limit',
        '[glirastes] View context of "broken" not sent as registered: invalid-entity',
        '[glirastes] View context of "cyclic" not sent as registered: not-serializable',
      ]);
      expect(lines.join()).not.toContain('secret');
      warn.mockClear();
      vi.stubEnv('NODE_ENV', 'production');
      register('late', { label: 'x' } as unknown as ViewContextEntry);
      currentViewContext();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });

  it('keeps a bounded memory of what it named: after many sources an early one is named again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');
    const bad = { label: 'x' } as unknown as ViewContextEntry;
    try {
      const named = (source: string) => {
        const off = registerViewContext(source, bad);
        warn.mockClear();
        currentViewContext();
        off();
        return warn.mock.calls.length;
      };
      expect(named('early')).toBe(1);
      expect(named('early')).toBe(0);
      for (let index = 0; index < 250; index += 1) named(`remount-${index}`);
      expect(named('early')).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });
});
