import { describe, expect, it, vi } from 'vitest';
import {
  assertToolMiddleware,
  composeToolMiddleware,
  type ToolMiddleware,
  type ToolMiddlewareCall,
  type ToolMiddlewareNext,
} from '../tool-middleware.js';

const call: ToolMiddlewareCall = {
  toolName: 'tasks_list',
  toolId: 'tasks.list',
  toolCallId: 'c1',
  input: { id: 'a' },
  method: 'GET',
  readOnly: true,
  context: { currentDate: '2026-11-21', locale: 'en', runtime: 'test' } as never,
  abortSignal: undefined,
};

describe('composeToolMiddleware', () => {
  it('runs outermost first and unwinds in reverse', async () => {
    const order: string[] = [];
    const mw = (label: string): ToolMiddleware => async (_call, next) => {
      order.push(`${label}>`);
      const value = await next();
      order.push(`<${label}`);
      return value;
    };
    const result = await composeToolMiddleware([mw('a'), mw('b'), mw('c')], call, async () => {
      order.push('tool');
      return 'done';
    });
    expect(result).toBe('done');
    expect(order).toEqual(['a>', 'b>', 'c>', 'tool', '<c', '<b', '<a']);
  });

  it('returns the value next resolved, or a mapped one', async () => {
    const run = async () => ({ n: 1 });
    expect(await composeToolMiddleware([(_c, next) => next()], call, run)).toEqual({ n: 1 });
    expect(
      await composeToolMiddleware(
        [async (_c, next) => ({ mapped: await next() })],
        call,
        run,
      ),
    ).toEqual({ mapped: { n: 1 } });
  });

  it('a middleware that does not call next short-circuits', async () => {
    const run = vi.fn(async () => 'tool');
    expect(await composeToolMiddleware([() => 'own'], call, run)).toBe('own');
    expect(run).not.toHaveBeenCalled();
  });

  it('next() twice rejects and runs the tool once', async () => {
    const run = vi.fn(async () => 'tool');
    await expect(
      composeToolMiddleware(
        [async (_c, next) => {
          await next();
          return next();
        }],
        call,
        run,
      ),
    ).rejects.toThrow('toolMiddleware called next() more than once');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('next() twice in parallel runs the tool once', async () => {
    const run = vi.fn(async () => 'tool');
    await expect(
      composeToolMiddleware([(_c, next) => Promise.all([next(), next()])], call, run),
    ).rejects.toThrow('toolMiddleware called next() more than once');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('late next() after the chain settled does not run', async () => {
    const run = vi.fn(async () => 'tool');
    let stored: ToolMiddlewareNext | undefined;
    const result = await composeToolMiddleware(
      [(_c, next) => {
        stored = next;
        return 'early';
      }],
      call,
      run,
    );
    expect(result).toBe('early');
    await expect(stored!()).rejects.toThrow('toolMiddleware called next() after the tool call ended');
    expect(run).toHaveBeenCalledTimes(0);
  });

  it('late next() of an inner middleware after a rejection does not run', async () => {
    const run = vi.fn(async () => 'tool');
    let stored: ToolMiddlewareNext | undefined;
    await expect(
      composeToolMiddleware(
        [(_c, next) => next(), (_c, next) => {
          stored = next;
          throw new Error('inner');
        }],
        call,
        run,
      ),
    ).rejects.toThrow('inner');
    await expect(stored!()).rejects.toThrow('toolMiddleware called next() after the tool call ended');
    expect(run).not.toHaveBeenCalled();
  });

  it('a sync throw becomes a rejection', async () => {
    const run = vi.fn(async () => 'tool');
    const promise = composeToolMiddleware(
      [() => {
        throw new Error('sync');
      }],
      call,
      run,
    );
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow('sync');
    expect(run).not.toHaveBeenCalled();
  });

  it('an empty chain runs the tool', async () => {
    expect(await composeToolMiddleware([], call, async () => 'tool')).toBe('tool');
  });
});

describe('assertToolMiddleware', () => {
  it('accepts undefined and arrays of functions, rejects anything else', () => {
    expect(() => assertToolMiddleware(undefined)).not.toThrow();
    expect(() => assertToolMiddleware([])).not.toThrow();
    expect(() => assertToolMiddleware([(_c: unknown, next: () => unknown) => next()])).not.toThrow();
    for (const value of [[1], {}, () => {}, null, 'x']) {
      expect(() => assertToolMiddleware(value)).toThrow(
        new TypeError('toolMiddleware must be an array of functions'),
      );
    }
  });
});
