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
});
