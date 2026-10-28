import { describe, expect, it } from 'vitest';
import { readActivitySteps, readLatestPlan } from '../activity.js';

const parts = [
  { type: 'text', text: 'Ich schaue nach.' },
  { type: 'tool-list_tasks', toolCallId: 'c1', state: 'output-available', output: { message: '3 Aufgaben' } },
  { type: 'tool-suggest_followups', toolCallId: 'c2', state: 'output-available', output: {} },
  { type: 'tool-create_team', toolCallId: 'c3', state: 'output-error', errorText: 'Name fehlt' },
  { type: 'dynamic-tool', toolName: 'invite_member', toolCallId: 'c4', state: 'approval-requested' },
  { type: 'tool-delete_task', toolCallId: 'c5', state: 'output-denied' },
  { type: 'tool-update_plan', toolCallId: 'c6', state: 'input-available', input: { items: [] } },
  { type: 'tool-archive_task', toolCallId: 'c7', state: 'input-streaming' },
];

describe('readActivitySteps', () => {
  it('lists app tool calls in order with their status, skipping SDK built-ins', () => {
    expect(readActivitySteps(parts, () => true)).toEqual([
      { id: 'c1', toolName: 'list_tasks', status: 'done', detail: '3 Aufgaben' },
      { id: 'c3', toolName: 'create_team', status: 'error', detail: 'Name fehlt' },
      { id: 'c4', toolName: 'invite_member', status: 'waiting' },
      { id: 'c5', toolName: 'delete_task', status: 'error' },
      { id: 'c7', toolName: 'archive_task', status: 'running' },
    ]);
  });

  it('leaves out details the display mode does not allow', () => {
    expect(readActivitySteps(parts.slice(0, 4), () => false)).toEqual([
      { id: 'c1', toolName: 'list_tasks', status: 'done' },
      { id: 'c3', toolName: 'create_team', status: 'error' },
    ]);
  });
});

describe('readLatestPlan', () => {
  it('reads the items of the last plan call', () => {
    expect(readLatestPlan([
      { type: 'tool-update_plan', toolCallId: 'p1', state: 'output-available', input: {
        items: [{ title: 'Suchen', status: 'in_progress' }, { title: 'Anlegen', status: 'pending' }],
      } },
      { type: 'tool-list_tasks', toolCallId: 'c1', state: 'output-available', output: {} },
      { type: 'tool-update_plan', toolCallId: 'p2', state: 'input-available', input: {
        items: [{ title: 'Suchen', status: 'completed' }, { title: 'Anlegen', status: 'in_progress' }],
      } },
    ])).toEqual([
      { title: 'Suchen', status: 'completed' },
      { title: 'Anlegen', status: 'in_progress' },
    ]);
  });

  it('returns null without a plan call', () => {
    expect(readLatestPlan(parts.slice(0, 2))).toBeNull();
  });
});
