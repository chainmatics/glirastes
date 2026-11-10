import { describe, expect, it } from 'vitest';
import { createApprovalDescriptionGenerator } from '../create-approval-description.js';
import { collectEntityNames } from '../entity-names.js';

const TASK = '14f1e041-4609-4b24-a723-631b133115cc';
const SUBTASK = '0df1344c-6fa7-4ea1-bc23-f0d12e01a0b1';
const OTHER = 'a42b5f62-5851-4350-bd72-187314ae3e4f';

function toolMessage(output: unknown, state = 'output-available') {
  return { role: 'assistant', parts: [{ type: 'tool-tasks_list', state, output }] };
}

describe('collectEntityNames', () => {
  it('reads the names of listed and nested records from tool results', () => {
    const names = collectEntityNames([
      toolMessage({ success: true, tasks: [{ id: TASK, title: 'Angebot Meier', subtasks: [{ id: SUBTASK, title: 'Preise prüfen' }] }] }),
      toolMessage({ success: true, data: [{ id: OTHER, name: 'Vertrieb' }] }),
    ]);

    expect(names.get(TASK)).toBe('Angebot Meier');
    expect(names.get(SUBTASK)).toBe('Preise prüfen');
    expect(names.get(OTHER)).toBe('Vertrieb');
  });

  it('prefers the latest result and ignores unfinished calls, inputs and non-UUID ids', () => {
    const names = collectEntityNames([
      toolMessage({ id: TASK, title: 'Alt' }),
      toolMessage({ id: TASK, title: 'Neu' }),
      toolMessage({ id: OTHER, title: 'Nur angefragt' }, 'approval-requested'),
      { role: 'assistant', parts: [{ type: 'tool-tasks_update', state: 'output-available', input: { id: SUBTASK, title: 'Behauptet' }, output: { success: true } }] },
      toolMessage({ id: '42', title: 'Keine UUID' }),
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]);

    expect(names.get(TASK)).toBe('Neu');
    expect(names.size).toBe(1);
  });
});

describe('approval card names', () => {
  const describeApproval = createApprovalDescriptionGenerator({
    fieldLabels: { taskTitle: 'Aufgabe', title: 'Titel' },
    nameLabels: { id: 'Ziel', subtaskId: 'Unteraufgabe', taskIds: 'Aufgaben' },
    hiddenFields: ['id', 'subtaskId', 'taskIds'],
  });
  const names = new Map([[TASK, 'Angebot Meier'], [SUBTASK, 'Preise prüfen'], [OTHER, 'Rechnung Schulz']]);

  it('shows the known name of an id the tool arguments only carry as UUID', () => {
    const card = describeApproval('tasks_toggleSubtask', 'a1', { id: TASK, subtaskId: SUBTASK }, { names });

    expect(card.details).toEqual(['Ziel: Angebot Meier', 'Unteraufgabe: Preise prüfen']);
  });

  it('names the known entries of an id list', () => {
    const card = describeApproval('tasks_bulkDelete', 'a1', { taskIds: [TASK, OTHER, SUBTASK.replace('0', '1')] }, { names });

    expect(card.details).toEqual(['Aufgaben: Angebot Meier, Rechnung Schulz']);
  });

  it('does not repeat a name the arguments already state', () => {
    const card = describeApproval('tasks_update', 'a1', { id: TASK, taskTitle: 'Angebot Meier', title: 'Angebot Müller' }, { names });

    expect(card.details).toEqual(['Aufgabe: Angebot Meier', 'Titel: Angebot Müller']);
  });

  it('shows the known name next to a differing claimed one', () => {
    const card = describeApproval('tasks_delete', 'a1', { id: TASK, taskTitle: 'Quartalsplanung' }, { names });

    expect(card.details).toEqual(['Aufgabe: Quartalsplanung', 'Ziel: Angebot Meier']);
  });

  it('keeps ids hidden without known names or name labels', () => {
    expect(describeApproval('tasks_delete', 'a1', { id: TASK }).details).toEqual([]);
    expect(describeApproval('tasks_delete', 'a1', { id: TASK }, { names: new Map() }).details).toEqual([]);
    const plain = createApprovalDescriptionGenerator({});
    expect(plain('tasks_delete', 'a1', { id: TASK }, { names }).details).toEqual([]);
  });
});
