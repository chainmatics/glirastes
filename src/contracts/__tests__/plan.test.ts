import { describe, expect, it } from 'vitest';
import { PLAN_MAX_ITEMS, PLAN_TOOL_NAME, readPlanItems } from '../plan.js';

describe('plan contract', () => {
  it('names the built-in plan tool', () => {
    expect(PLAN_TOOL_NAME).toBe('update_plan');
  });

  it('reads well-formed items in order', () => {
    expect(readPlanItems({
      items: [
        { title: 'Aufgaben suchen', status: 'completed' },
        { title: 'Team anlegen', status: 'in_progress' },
        { title: 'Mitglieder einladen', status: 'pending' },
      ],
    })).toEqual([
      { title: 'Aufgaben suchen', status: 'completed' },
      { title: 'Team anlegen', status: 'in_progress' },
      { title: 'Mitglieder einladen', status: 'pending' },
    ]);
  });

  it('drops malformed items and rejects input without items', () => {
    expect(readPlanItems({
      items: [
        { title: '  ', status: 'pending' },
        { title: 'Team anlegen', status: 'started' },
        { title: 'Bericht', status: 'pending' },
        'Text',
      ],
    })).toEqual([{ title: 'Bericht', status: 'pending' }]);
    expect(readPlanItems(undefined)).toBeNull();
    expect(readPlanItems({ items: 'nope' })).toBeNull();
  });

  it('caps the number of items', () => {
    const items = Array.from({ length: PLAN_MAX_ITEMS + 3 }, (_, index) => ({
      title: `Schritt ${index}`, status: 'pending',
    }));
    expect(readPlanItems({ items })).toHaveLength(PLAN_MAX_ITEMS);
  });
});
