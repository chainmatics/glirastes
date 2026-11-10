import { describe, expect, it, vi } from 'vitest';
import { createClarificationTool } from '../clarification-tool.js';

const context = { currentDate: new Date('2026-10-04T08:00:00.000Z'), locale: 'de-DE' };

describe('createClarificationTool', () => {
  it('returns a structured request without touching the app', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = createClarificationTool()!;
      expect(tool.id).toBe('ask_clarification');
      expect(tool.needsApproval).toBe(false);
      const input = tool.inputSchema.safeParse({
        question: 'Welche Aufgabe soll ich löschen?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Bericht schreiben' },
          { id: 'task-2', label: 'Release prüfen' },
        ],
      });
      expect(input.success).toBe(true);
      const result = await tool.execute((input as { data: unknown }).data, context);
      expect(result).toEqual({
        success: true,
        clarification: {
          question: 'Welche Aufgabe soll ich löschen?',
          target: 'object',
          options: [
            { id: 'task-1', label: 'Bericht schreiben' },
            { id: 'task-2', label: 'Release prüfen' },
          ],
          allowFreeText: true,
        },
        _instruction: expect.stringMatching(/wait for the answer/),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [{ question: '', target: 'object' }],
    [{ question: 'Wer?', target: 'manager' }],
    [{ question: 'Wer?', target: 'person', options: [], allowFreeText: false }],
    [{ question: 'Wer?', target: 'person', options: [
      { id: 'a', label: 'Alice' }, { id: 'a', label: 'Alex' },
    ] }],
    [{ question: 'Wer?', target: 'person', options: Array.from({ length: 7 }, (_, index) => ({
      id: `p${index}`, label: `Person ${index}`,
    })) }],
  ])('rejects invalid requests %j', (input) => {
    expect(createClarificationTool()!.inputSchema.safeParse(input).success).toBe(false);
  });

  it('can be disabled and re-described', () => {
    expect(createClarificationTool({ enabled: false })).toBeNull();
    expect(createClarificationTool({ description: 'Rückfrage stellen.' })!.description)
      .toBe('Rückfrage stellen.');
  });
});
