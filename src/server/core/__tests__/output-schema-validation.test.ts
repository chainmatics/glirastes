import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../types.js';
import { toolToAiTool } from '../index.js';

describe('tool output schema validation', () => {
  it('validates the declared payload without rejecting transport metadata', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = defineTool({
      id: 'tasks.list',
      description: 'List tasks.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        tasks: z.array(z.object({ title: z.string() }).strict()),
      }).strict(),
      execute: async () => ({
        success: true as const,
        tasks: [{ title: 'Pilot pruefen' }],
        uiAction: { type: 'navigate', path: '/tasks' },
      }),
    });
    const aiTool = toolToAiTool(tool, {
      currentDate: new Date('2026-08-15T10:00:00.000Z'),
      locale: 'de-DE',
    });

    await expect(aiTool.execute({})).resolves.toEqual({
      success: true,
      tasks: [{ title: 'Pilot pruefen' }],
      uiAction: { type: 'navigate', path: '/tasks' },
    });
    expect(warning).not.toHaveBeenCalled();

    warning.mockRestore();
  });

  it('returns a bounded error instead of leaking a mismatched payload', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = defineTool({
      id: 'tasks.list',
      description: 'List tasks.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        tasks: z.array(z.object({
          id: z.string(),
          creatorId: z.string(),
        }).strict()),
      }).strict(),
      execute: async () => ({
        success: true as const,
        tasks: [{
          id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04',
          title: 'Pilot pruefen',
          rank: 0.75,
        }],
      }),
    });
    const aiTool = toolToAiTool(tool, {
      currentDate: new Date('2026-08-15T10:00:00.000Z'),
      locale: 'de-DE',
    });

    const result = await aiTool.execute({});

    expect(result).toEqual({
      success: false,
      error: 'Tool output did not match its declared schema.',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('Pilot pruefen');
    expect(JSON.stringify(result)).not.toContain('rank');
    expect(warning).toHaveBeenCalledTimes(1);

    warning.mockRestore();
  });

  it('preserves a declared success field while stripping transport uiAction', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = defineTool({
      id: 'tasks.create',
      description: 'Create a task.',
      inputSchema: z.object({ title: z.string() }).strict(),
      outputSchema: z.object({
        success: z.literal(true),
        taskId: z.string(),
      }).strict(),
      execute: async () => ({
        success: true as const,
        taskId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04',
        uiAction: { type: 'navigate', path: '/tasks' },
      }),
    });
    const aiTool = toolToAiTool(tool, {
      currentDate: new Date('2026-08-15T10:00:00.000Z'),
      locale: 'de-DE',
    });

    await expect(aiTool.execute({ title: 'Pilot pruefen' })).resolves.toEqual({
      success: true,
      taskId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04',
      uiAction: { type: 'navigate', path: '/tasks' },
    });
    expect(warning).not.toHaveBeenCalled();

    warning.mockRestore();
  });
});
