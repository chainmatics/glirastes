import { describe, expect, it } from 'vitest';
import { actionLabel, commandLabel, humanizeIdentifier, identifierWords, phraseLabel, singular, VERBS } from './chat-labels.js';

describe('chat labels', () => {
  it('splits identifiers into lower-case words', () => {
    expect(identifierWords('taskCreateDialog.open')).toEqual(['task', 'create', 'dialog', 'open']);
    expect(identifierWords('convert-to-team')).toEqual(['convert', 'to', 'team']);
  });

  it('keeps the existing humanized identifiers', () => {
    expect(humanizeIdentifier('myTasks')).toBe('My tasks');
    expect(humanizeIdentifier('team-members')).toBe('Team members');
    expect(humanizeIdentifier('tasks.highlight')).toBe('Tasks highlight');
  });

  it('never reads a verb from the object prototype', () => {
    expect(Object.isFrozen(VERBS)).toBe(true);
    expect(phraseLabel(['constructor'])).toBeUndefined();
    expect(phraseLabel(['to', 'string'])).toBeUndefined();
  });

  it('puts the verb first in English and last in German', () => {
    expect(phraseLabel(['open'])).toEqual({ en: 'Open', de: 'Öffnen' });
    expect(phraseLabel(['attachable'], 'show')).toEqual({ en: 'Show attachable', de: 'Attachable anzeigen' });
    expect(phraseLabel(['reopen', 'task'])).toEqual({ en: 'Reopen task', de: 'Task wieder öffnen' });
  });

  it('labels client actions as verb and object', () => {
    expect(commandLabel('taskCreateDialog.open')).toEqual({ en: 'Open task create dialog', de: 'Task create dialog öffnen' });
    expect(commandLabel('tasks.filters.apply')).toEqual({ en: 'Apply tasks filters', de: 'Tasks filters anwenden' });
    expect(commandLabel('tasks.view.switch')).toEqual({ en: 'Switch tasks view', de: 'Tasks view wechseln' });
    expect(commandLabel('dashboard.refresh')).toEqual({ en: 'Refresh dashboard', de: 'Dashboard aktualisieren' });
    expect(commandLabel('action.navigate')).toEqual({ en: 'Action navigate', de: 'Action navigate' });
  });

  it('takes the title per language before the derived label', () => {
    expect(commandLabel('taskCreateDialog.open', { de: 'Dialog Aufgabe anlegen' }))
      .toEqual({ en: 'Open task create dialog', de: 'Dialog Aufgabe anlegen' });
    expect(actionLabel({
      definitionId: 'tasks.permanentDelete', method: 'DELETE', trailingSegment: 'permanent',
      title: { de: 'Aufgabe endgültig löschen', en: 'Permanently delete task' },
    })).toEqual({ en: 'Permanently delete task', de: 'Aufgabe endgültig löschen' });
  });

  it('labels entity actions from the id, the path and the method', () => {
    const cases: Array<[Parameters<typeof actionLabel>[0], { en: string; de: string }]> = [
      [{ definitionId: 'tasks.permanentDelete', method: 'DELETE', trailingSegment: 'permanent' }, { en: 'Delete permanent', de: 'Permanent löschen' }],
      [{ definitionId: 'tasks.addSubtask', method: 'POST', trailingSegment: 'subtasks' }, { en: 'Add subtask', de: 'Subtask hinzufügen' }],
      [{ definitionId: 'tasks.getActivity', method: 'GET', trailingSegment: 'activity' }, { en: 'Show activity', de: 'Activity anzeigen' }],
      [{ definitionId: 'tasks.complete', method: 'POST', trailingSegment: 'complete' }, { en: 'Complete', de: 'Erledigen' }],
      [{ definitionId: 'tasksConvert.create', method: 'POST', trailingSegment: 'convert-to-team' }, { en: 'Convert to team', de: 'To team umwandeln' }],
      [{ definitionId: 'tasksAttachable.list', method: 'GET', trailingSegment: 'attachable' }, { en: 'Show attachable', de: 'Attachable anzeigen' }],
      [{ definitionId: 'tasksPermanent.remove', method: 'DELETE', trailingSegment: 'permanent' }, { en: 'Delete permanent', de: 'Permanent löschen' }],
      [{ definitionId: 'tasksSubtasks.create', method: 'POST', trailingSegment: 'subtasks' }, { en: 'Add subtask', de: 'Subtask hinzufügen' }],
      [{ definitionId: 'tasksReminders.replace', method: 'PUT', trailingSegment: 'reminders' }, { en: 'Edit reminders', de: 'Reminders bearbeiten' }],
      [{ definitionId: 'notesPin.create', method: 'POST', trailingSegment: 'pin' }, { en: 'Pin', de: 'Anheften' }],
      [{ definitionId: 'notesLabel.create', method: 'POST', trailingSegment: 'label' }, { en: 'Label', de: 'Label' }],
      [{ definitionId: 'tasks.update', method: 'PATCH' }, { en: 'Edit', de: 'Bearbeiten' }],
      [{ definitionId: 'tasks.constructor' }, { en: 'Constructor', de: 'Constructor' }],
    ];
    for (const [input, expected] of cases) expect(actionLabel(input), input.definitionId).toEqual(expected);
  });

  it('makes plural segments singular', () => {
    expect(singular('subtasks')).toBe('subtask');
    expect(singular('categories')).toBe('category');
    expect(singular('people')).toBe('person');
  });
});
