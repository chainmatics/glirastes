import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type AuditEvent, type ToolContext, type ToolRegistry } from '../../../types.js';
import { toolsToAiTools } from '../index.js';
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

describe('toolToAiTool with toolMiddleware', () => {
  const ctx: ToolContext = { currentDate: new Date('2026-11-21T10:00:00.000Z'), locale: 'en' };

  function registry(execute: (input: unknown) => unknown, extra: Record<string, unknown> = {}): ToolRegistry {
    return {
      tasks_list: defineTool({
        id: 'tasks.list',
        description: 'List tasks.',
        method: 'get',
        inputSchema: z.object({ id: z.string() }).passthrough(),
        execute: async (input: unknown) => execute(input),
        ...extra,
      } as never),
    };
  }
  type Exec = (input: unknown, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => Promise<unknown>;
  const execOf = (tools: Record<string, { execute: unknown }>) => tools.tasks_list!.execute as Exec;

  it('passes the call fields', async () => {
    const seen: ToolMiddlewareCall[] = [];
    const tools = toolsToAiTools(registry(() => ({ ok: true })), ctx, {
      toolMiddleware: [(c, next) => (seen.push(c), next())],
    });
    expect(await execOf(tools)({ id: 'a' }, { toolCallId: 'c1' })).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolName: 'tasks_list',
      toolId: 'tasks.list',
      toolCallId: 'c1',
      input: { id: 'a' },
      method: 'GET',
      readOnly: true,
    });
    expect(seen[0]!.context.locale).toBe('en');
  });

  it('the tool executes with the original input even if the middleware mutates call.input', async () => {
    const tool = vi.fn((_input: unknown) => ({ ok: true }));
    const tools = toolsToAiTools(registry(tool), ctx, {
      toolMiddleware: [(c, next) => {
        (c.input as { id: string }).id = 'x';
        return next();
      }],
    });
    await execOf(tools)({ id: 'a' }, { toolCallId: 'c1' });
    expect(tool).toHaveBeenCalledTimes(1);
    expect(tool.mock.calls[0]![0]).toEqual({ id: 'a' });
  });

  it('a throw before next never executes the tool and returns the standard error result', async () => {
    const tool = vi.fn(() => ({ ok: true }));
    const onError = vi.fn();
    const audits: AuditEvent[] = [];
    const error = new Error('boom');
    const tools = toolsToAiTools(registry(tool), ctx, {
      onError,
      onAudit: (event) => audits.push(event),
      toolMiddleware: [() => {
        throw error;
      }],
    });
    expect(await execOf(tools)({ id: 'a' }, { toolCallId: 'c1' })).toEqual({
      error: 'Error in tasks_list: boom',
      hint: 'Check the parameters and try again.',
    });
    expect(tool).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('tasks.list', error);
    expect(audits.map((event) => event.type)).toEqual(['tool.failed']);
  });

  it('a throw after next returns the error result; the tool ran once', async () => {
    const tool = vi.fn(() => ({ ok: true }));
    const tools = toolsToAiTools(registry(tool), ctx, {
      toolMiddleware: [async (_c, next) => {
        await next();
        throw new Error('after');
      }],
    });
    expect(await execOf(tools)({ id: 'a' })).toEqual({
      error: 'Error in tasks_list: after',
      hint: 'Check the parameters and try again.',
    });
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('a short-circuit result is bounded like a tool result', async () => {
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, title: 'x'.repeat(20) })) };
    const options = { maxResultChars: 1000 };
    const viaTool = await execOf(toolsToAiTools(registry(() => big), ctx, options))({ id: 'a' });
    const tool = vi.fn(() => ({ ok: true }));
    const viaMiddleware = await execOf(
      toolsToAiTools(registry(tool), ctx, { ...options, toolMiddleware: [() => big] }),
    )({ id: 'a' });
    expect(tool).not.toHaveBeenCalled();
    expect(viaMiddleware).toEqual(viaTool);
    expect(JSON.stringify(viaMiddleware).length).toBeLessThan(JSON.stringify(big).length);

    const record = { id: 't1', title: 'T', secret: 's' };
    const allowed = { outputAllowedFields: ['id', 'title'] };
    const fromTool = await execOf(toolsToAiTools(registry(() => record, allowed), ctx))({ id: 'a' });
    const fromMiddleware = await execOf(
      toolsToAiTools(registry(() => ({}), allowed), ctx, { toolMiddleware: [() => record] }),
    )({ id: 'a' });
    expect(fromMiddleware).toEqual(fromTool);
    expect(JSON.stringify(fromMiddleware)).not.toContain('secret');
  });

  it('no middleware: input is not cloned', async () => {
    const tool = vi.fn((_input: unknown) => ({ ok: true }));
    const input = { id: 'a', fn: () => 1 };
    expect(await execOf(toolsToAiTools(registry(tool), ctx))(input)).toEqual({ ok: true });
    expect(tool.mock.calls[0]![0]).toBe(input);
    expect(await execOf(toolsToAiTools(registry(tool), ctx, { toolMiddleware: [] }))(input)).toEqual({ ok: true });
    expect(tool).toHaveBeenCalledTimes(2);

    const mw = vi.fn((_c: ToolMiddlewareCall, next: ToolMiddlewareNext) => next());
    const result = await execOf(toolsToAiTools(registry(tool), ctx, { toolMiddleware: [mw] }))(input);
    expect(result).toMatchObject({ error: expect.stringMatching(/^Error in tasks_list: /), hint: 'Check the parameters and try again.' });
    expect(mw).not.toHaveBeenCalled();
    expect(tool).toHaveBeenCalledTimes(2);
  });

  it('toolsToAiTools rejects a non-array toolMiddleware', () => {
    expect(() => toolsToAiTools(registry(() => 1), ctx, { toolMiddleware: (() => 1) as never })).toThrow(
      new TypeError('toolMiddleware must be an array of functions'),
    );
  });
});
