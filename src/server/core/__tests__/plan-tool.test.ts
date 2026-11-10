import { describe, expect, it, vi } from 'vitest';
import { createPlanTool } from '../plan-tool.js';

const context = { currentDate: new Date('2026-10-28T08:00:00.000Z'), locale: 'de-DE' };

describe('createPlanTool', () => {
  it('records a plan without touching the app', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = createPlanTool()!;
      expect(tool.id).toBe('update_plan');
      expect(tool.needsApproval).toBe(false);
      expect(tool.description).toMatch(/several/);
      const input = tool.inputSchema.safeParse({
        items: [
          { title: 'Aufgaben suchen', status: 'in_progress' },
          { title: 'Team anlegen', status: 'pending' },
        ],
      });
      expect(input.success).toBe(true);
      const result = await tool.execute((input as { data: unknown }).data, context);
      expect(result).toEqual({ success: true, items: 2 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('needs at least two items with a known status', () => {
    const tool = createPlanTool()!;
    expect(tool.inputSchema.safeParse({ items: [{ title: 'Eins', status: 'pending' }] }).success)
      .toBe(false);
    expect(tool.inputSchema.safeParse({
      items: [{ title: 'Eins', status: 'pending' }, { title: 'Zwei', status: 'started' }],
    }).success).toBe(false);
  });

  it('takes a custom description and can be disabled', () => {
    expect(createPlanTool({ description: 'Plane mehrteilige Aufträge.' })!.description)
      .toBe('Plane mehrteilige Aufträge.');
    expect(createPlanTool({ enabled: false })).toBeNull();
  });
});
