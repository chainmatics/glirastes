import { describe, expect, it } from 'vitest';
import { extractTrailingFollowupSuggestions } from '../followup-suggestions.js';

describe('extractTrailingFollowupSuggestions', () => {
  it('extracts a trailing German Markdown suggestion list', () => {
    expect(extractTrailingFollowupSuggestions(
      'Kanban-Ansicht geöffnet.\n\n**Vorschläge:**\n'
      + '- Zeige meine offenen Aufgaben im Kanban.\n'
      + '- Erstelle eine neue Aufgabe mit Titel „Projektplanung“.\n'
      + '- Filtere Aufgaben nach Priorität hoch.',
    )).toEqual({
      text: 'Kanban-Ansicht geöffnet.',
      suggestions: [
        'Zeige meine offenen Aufgaben im Kanban.',
        'Erstelle eine neue Aufgabe mit Titel „Projektplanung“.',
        'Filtere Aufgaben nach Priorität hoch.',
      ],
    });
  });

  it('extracts an English numbered suggestion list', () => {
    expect(extractTrailingFollowupSuggestions(
      'Dashboard opened.\n\nSuggestions:\n'
      + '1. Show today’s tasks.\n'
      + '2) Open the group overview.',
    )).toEqual({
      text: 'Dashboard opened.',
      suggestions: [
        'Show today’s tasks.',
        'Open the group overview.',
      ],
    });
  });

  it('deduplicates suggestions and applies the requested limit', () => {
    expect(extractTrailingFollowupSuggestions(
      'Fertig.\n\nVorschläge:\n'
      + '- Aufgaben öffnen\n'
      + '- Aufgaben öffnen\n'
      + '- Dashboard öffnen',
      1,
    )).toEqual({
      text: 'Fertig.',
      suggestions: ['Aufgaben öffnen'],
    });
  });

  it.each([
    'Meine Vorschläge: Aufgaben öffnen.',
    'Fertig.\n\nVorschläge:',
    'Vorschläge:\n- Aufgaben öffnen\n\nDas war alles.',
    'Fertig.\n\nVorschläge:\n- Eins\n- Zwei\n- Drei\n- Vier\n- Fünf\n- Sechs',
  ])('leaves non-contract prose unchanged: %s', (text) => {
    expect(extractTrailingFollowupSuggestions(text)).toEqual({
      text,
      suggestions: [],
    });
  });
});
