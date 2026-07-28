import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAiSdkTools } from '../engine.js';

describe('createAiSdkTools', () => {
  it('guards every tool execution and reports success', async () => {
    const calls: string[] = [];
    const tools = createAiSdkTools({
      tools: {
        list_tasks: {
          description: 'List tasks.',
          parameters: z.object({ status: z.string() }),
          execute: async (input) => {
            calls.push(`execute:${JSON.stringify(input)}`);
            return { count: 2 };
          },
        },
      },
      beforeToolCall: async ({ toolName, input }) => {
        calls.push(`before:${toolName}:${JSON.stringify(input)}`);
      },
      afterToolCall: async ({ toolName, result }) => {
        calls.push(`after:${toolName}:${JSON.stringify(result)}`);
      },
    });

    const result = await tools.list_tasks!.execute!(
      { status: 'open' },
      {} as never,
    );

    expect(result).toEqual({ count: 2 });
    expect(calls).toEqual([
      'before:list_tasks:{"status":"open"}',
      'execute:{"status":"open"}',
      'after:list_tasks:{"count":2}',
    ]);
  });

  it('fails closed when the pre-execution guard denies a tool', async () => {
    const execute = vi.fn();
    const tools = createAiSdkTools({
      tools: {
        delete_task: {
          description: 'Delete a task.',
          parameters: z.object({ id: z.string() }),
          execute,
        },
      },
      beforeToolCall: async () => {
        throw new Error('policy revoked');
      },
    });

    await expect(tools.delete_task!.execute!(
      { id: 'task-1' },
      {} as never,
    )).rejects.toThrow('policy revoked');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports tool failures without converting them into success', async () => {
    const onToolError = vi.fn();
    const tools = createAiSdkTools({
      tools: {
        update_task: {
          description: 'Update a task.',
          parameters: z.object({ id: z.string() }),
          execute: async () => {
            throw new TypeError('database unavailable');
          },
        },
      },
      onToolError,
    });

    await expect(tools.update_task!.execute!(
      { id: 'task-1' },
      {} as never,
    )).rejects.toThrow('database unavailable');
    expect(onToolError).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'update_task',
      error: expect.any(TypeError),
      durationMs: expect.any(Number),
    }));
  });

  it('preserves AI SDK approval configuration', () => {
    const tools = createAiSdkTools({
      tools: {
        delete_task: {
          description: 'Delete a task.',
          parameters: z.object({ id: z.string() }),
          needsApproval: true,
          execute: async () => ({ success: true }),
        },
      },
    });

    expect(tools.delete_task!.needsApproval).toBe(true);
  });

  it('uses the pinned runtime approval resolver instead of source metadata', async () => {
    const resolveApproval = vi.fn(async () => true);
    const tools = createAiSdkTools({
      tools: {
        update_task: {
          description: 'Update a task.',
          parameters: z.object({ id: z.string() }),
          needsApproval: false,
          execute: async () => ({ success: true }),
        },
      },
      resolveApproval,
    });

    await expect((tools.update_task!.needsApproval as (input: unknown) => Promise<boolean>)({
      id: 'task-1',
    })).resolves.toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith({
      toolName: 'update_task',
      input: { id: 'task-1' },
    });
  });

  it('fails a tool that exceeds its local timeout', async () => {
    vi.useFakeTimers();
    const tools = createAiSdkTools({
      tools: {
        slow_tool: {
          description: 'Never finishes.',
          parameters: z.object({}),
          execute: () => new Promise(() => {}),
        },
      },
      toolTimeoutMs: 50,
    });

    const execution = tools.slow_tool!.execute!({}, {} as never);
    const rejection = expect(execution).rejects.toThrow(/timed out.*50/i);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    vi.useRealTimers();
  });
});
