// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../activity-log.js';
import { PlanChecklist } from '../plan-checklist.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({
    classNames: {},
    locale: deChatLocale,
    toolLabels: {
      labels: {
        list_tasks: { singular: 'Aufgaben lesen', plural: 'Aufgaben lesen' },
        create_team: { singular: 'Team anlegen', plural: 'Teams anlegen' },
      },
    },
  }),
}));

afterEach(cleanup);

function root() {
  return document.querySelector('[data-component="activity-log"]') as HTMLDetailsElement | null;
}

function rows() {
  return Array.from(document.querySelectorAll('[data-element="activity-step"]'));
}

describe('ActivityLog', () => {
  it('renders nothing without tool steps', () => {
    const { container } = render(<ActivityLog steps={[]} active />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the running tool as one collapsed line with a spinner', () => {
    render(
      <ActivityLog
        active
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'done' },
          { id: 'c2', toolName: 'create_team', status: 'running' },
        ]}
      />,
    );
    expect(root()!.open).toBe(false);
    expect(root()!.getAttribute('data-state')).toBe('running');
    const summary = document.querySelector('[data-element="activity-summary"]')!;
    expect(summary.textContent).toContain('Team anlegen…');
    expect(summary.querySelector('[data-icon="spinner"]')).not.toBeNull();
  });

  it('says it is working between tool calls of an active turn', () => {
    render(<ActivityLog active steps={[{ id: 'c1', toolName: 'list_tasks', status: 'done' }]} />);
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toContain('Arbeitet…');
  });

  it('sums up a finished turn and expands to the steps in order', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'done', detail: '3 Aufgaben' },
          { id: 'c2', toolName: 'create_team', status: 'error', detail: 'Name fehlt' },
          { id: 'c3', toolName: 'unknown_tool', status: 'done' },
        ]}
      />,
    );
    const summary = document.querySelector('[data-element="activity-summary"]')!;
    expect(root()!.getAttribute('data-state')).toBe('error');
    expect(summary.textContent).toContain('3 Schritte ausgeführt');
    expect(summary.textContent).toContain('1 fehlgeschlagen');

    fireEvent.click(summary);
    expect(root()!.open).toBe(true);
    expect(rows().map((row) => row.getAttribute('data-status'))).toEqual(['done', 'error', 'done']);
    expect(rows().map((row) => row.querySelector('[data-element="icon"]')!.getAttribute('data-icon')))
      .toEqual(['check', 'error', 'check']);
    expect(rows()[0].textContent).toContain('Aufgaben lesen');
    expect(rows()[0].textContent).toContain('3 Aufgaben');
    expect(rows()[1].textContent).toContain('Name fehlt');
    expect(rows()[2].textContent).toContain('unknown_tool');
  });

  it('uses the singular for one step', () => {
    render(<ActivityLog active={false} steps={[{ id: 'c1', toolName: 'list_tasks', status: 'done' }]} />);
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toContain('1 Schritt ausgeführt');
  });

  it('shows a waiting approval in the summary line', () => {
    render(<ActivityLog active={false} steps={[{ id: 'c1', toolName: 'create_team', status: 'waiting' }]} />);
    expect(root()!.getAttribute('data-state')).toBe('waiting');
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toContain('Wartet auf Freigabe');
  });

  it('adds a pipeline notice as the last line', () => {
    render(
      <ActivityLog
        active={false}
        notice="Sicherheitsstopp"
        steps={[{ id: 'c1', toolName: 'list_tasks', status: 'done' }]}
      />,
    );
    expect(document.querySelector('[data-element="activity-notice"]')!.textContent)
      .toBe('Sicherheitsstopp');
  });

  it('has English defaults for every new text', () => {
    expect(DEFAULT_LOCALE.activityDoneLabel).toBe('{count} steps done');
    expect(DEFAULT_LOCALE.activityDoneOneLabel).toBe('1 step done');
  });
});

describe('PlanChecklist', () => {
  const items = [
    { title: 'Aufgaben suchen', status: 'completed' as const },
    { title: 'Team anlegen', status: 'in_progress' as const },
    { title: 'Mitglieder einladen', status: 'pending' as const },
  ];

  function planRows() {
    return Array.from(document.querySelectorAll('[data-element="plan-item"]'));
  }

  it('renders nothing for fewer than two items', () => {
    const { container } = render(<PlanChecklist active items={items.slice(0, 1)} />);
    expect(container.innerHTML).toBe('');
  });

  it('checks done items, spins the current one and dims pending ones', () => {
    render(<PlanChecklist active items={items} />);
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(planRows().map((row) => row.getAttribute('data-status')))
      .toEqual(['completed', 'in_progress', 'pending']);
    expect(planRows().map((row) => row.querySelector('[data-element="icon"]')!.getAttribute('data-icon')))
      .toEqual(['check', 'spinner', 'pending']);
    expect(planRows()[1].textContent).toContain('Team anlegen');
  });

  it('stops spinning once the turn is over', () => {
    render(<PlanChecklist active={false} items={items} />);
    expect(planRows()[1].querySelector('[data-element="icon"]')!.getAttribute('data-icon'))
      .toBe('pending');
  });
});
