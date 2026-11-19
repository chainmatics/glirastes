// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../activity-log.js';
import { PlanChecklist } from '../plan-checklist.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';

const chatContext = vi.hoisted(() => ({
  current: {
    classNames: {},
    components: {} as Record<string, unknown>,
    activityLog: {} as Record<string, unknown>,
    locale: {} as Record<string, string>,
    toolLabels: {
      labels: {
        list_tasks: { singular: 'Aufgaben lesen', plural: 'Aufgaben lesen' },
        create_team: { singular: 'Team anlegen', plural: 'Teams anlegen' },
      },
    },
  },
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

// vi.hoisted runs before imports, so the locale is set here.
chatContext.current.locale = deChatLocale as unknown as Record<string, string>;

afterEach(() => {
  cleanup();
  chatContext.current.components = {};
  chatContext.current.activityLog = {};
  chatContext.current.locale = deChatLocale as unknown as Record<string, string>;
});

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

  it('folds the same tool run several times in a row into one line with its count', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'done' },
          { id: 'c2', toolName: 'list_tasks', status: 'done' },
          { id: 'c3', toolName: 'list_tasks', status: 'done' },
          { id: 'c4', toolName: 'create_team', status: 'done' },
          { id: 'c5', toolName: 'create_team', status: 'error' },
          { id: 'c6', toolName: 'create_team', status: 'done', detail: 'Team Vertrieb' },
          { id: 'c7', toolName: 'list_tasks', status: 'done' },
        ]}
      />,
    );

    // The summary still counts every call.
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toBe('6 Schritte ausgeführt, 1 fehlgeschlagen');
    expect(rows().map((row) => row.textContent)).toEqual([
      'Aufgaben lesen×3',
      'Team anlegen',
      'Team anlegen',
      'Team anlegenTeam Vertrieb',
      'Aufgaben lesen',
    ]);
    expect(rows()[0].querySelector('[data-element="count"]')!.textContent).toBe('×3');
    expect(rows()[1].getAttribute('data-status')).toBe('done');
    expect(rows()[2].getAttribute('data-status')).toBe('error');
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
    expect(summary.textContent).toBe('2 Schritte ausgeführt, 1 fehlgeschlagen');

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

  it('shows a declined call neutrally: not counted as failed, no error state', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'done' },
          { id: 'c2', toolName: 'create_team', status: 'declined' },
        ]}
      />,
    );
    const summary = document.querySelector('[data-element="activity-summary"]')!;
    expect(root()!.getAttribute('data-state')).toBe('done');
    expect(summary.textContent).toBe('1 Schritt ausgeführt, 1 abgelehnt');
    expect(summary.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(rows()[1].getAttribute('data-status')).toBe('declined');
    expect(rows()[1].querySelector('[data-element="icon"]')!.getAttribute('data-icon')).toBe('declined');
  });

  it('shows an expected failure neutrally: counted on its own, not as failed, no error state', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'expected', detail: 'Nicht gefunden' },
          { id: 'c2', toolName: 'list_tasks', status: 'done' },
        ]}
      />,
    );
    const summary = document.querySelector('[data-element="activity-summary"]')!;
    expect(root()!.getAttribute('data-state')).toBe('done');
    expect(summary.textContent).toBe('1 Schritt ausgeführt, 1 ohne Ergebnis');
    expect(summary.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(rows()[0].getAttribute('data-status')).toBe('expected');
    expect(rows()[0].querySelector('[data-element="icon"]')!.getAttribute('data-icon')).toBe('notice');
    expect(rows()[0].textContent).toContain('Nicht gefunden');
  });

  it('counts failed, declined and expected calls apart', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'create_team', status: 'error' },
          { id: 'c2', toolName: 'list_tasks', status: 'declined' },
          { id: 'c3', toolName: 'list_tasks', status: 'expected' },
        ]}
      />,
    );
    expect(root()!.getAttribute('data-state')).toBe('error');
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toBe('1 fehlgeschlagen, 1 abgelehnt, 1 ohne Ergebnis');
  });

  it('counts failed and declined calls apart', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'create_team', status: 'error' },
          { id: 'c2', toolName: 'list_tasks', status: 'declined' },
        ]}
      />,
    );
    expect(root()!.getAttribute('data-state')).toBe('error');
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toBe('1 fehlgeschlagen, 1 abgelehnt');
  });

  it('words the summary true for every mix of outcomes (de and en)', () => {
    const summary = () => document.querySelector('[data-element="activity-summary"]')!.textContent;
    const cases: Array<[Array<'done' | 'error' | 'declined' | 'expected'>, string, string]> = [
      [['expected', 'expected'], '2 ohne Ergebnis', '2 without result'],
      [['declined', 'declined'], '2 abgelehnt', '2 declined'],
      [['done', 'declined'], '1 Schritt ausgeführt, 1 abgelehnt', '1 step done, 1 declined'],
      [['done', 'done', 'expected'], '2 Schritte ausgeführt, 1 ohne Ergebnis', '2 steps done, 1 without result'],
      [['error'], '1 fehlgeschlagen', '1 failed'],
      [['done', 'error', 'error', 'declined', 'expected'], '1 Schritt ausgeführt, 2 fehlgeschlagen, 1 abgelehnt, 1 ohne Ergebnis',
        '1 step done, 2 failed, 1 declined, 1 without result'],
    ];
    for (const [statuses, german, english] of cases) {
      const steps = statuses.map((status, i) => ({ id: `c${i}`, toolName: i % 2 ? 'list_tasks' : 'create_team', status }));
      for (const [locale, text] of [[deChatLocale, german], [DEFAULT_LOCALE, english]] as const) {
        chatContext.current.locale = locale as unknown as Record<string, string>;
        render(<ActivityLog active={false} steps={steps} />);
        expect(summary()).toBe(text);
        cleanup();
      }
    }
  });

  it('keeps an app override of the done texts, now with the done steps as {count}', () => {
    chatContext.current.locale = {
      ...deChatLocale,
      activityDoneLabel: '{count} Aktionen',
      activityDoneOneLabel: 'Eine Aktion',
    } as unknown as Record<string, string>;
    const view = render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'done' },
          { id: 'c2', toolName: 'create_team', status: 'done' },
          { id: 'c3', toolName: 'create_team', status: 'declined' },
        ]}
      />,
    );
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent).toBe('2 Aktionen, 1 abgelehnt');
    view.rerender(<ActivityLog active={false} steps={[{ id: 'c1', toolName: 'list_tasks', status: 'done' }]} />);
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent).toBe('Eine Aktion');
  });

  it('keeps an approval the server did not use apart from a refused one', () => {
    render(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'create_team', status: 'declined', declinedBy: 'user' },
          { id: 'c2', toolName: 'create_team', status: 'declined', declinedBy: 'server' },
        ]}
      />,
    );
    expect(rows()).toHaveLength(2);
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

  it('stays collapsed while running by default and opens only with expandWhileRunning', () => {
    const steps = [
      { id: 'c1', toolName: 'list_tasks', status: 'done' as const },
      { id: 'c2', toolName: 'create_team', status: 'running' as const },
    ];
    render(<ActivityLog active steps={steps} />);
    expect(root()!.open).toBe(false);
    expect(root()!.hasAttribute('open')).toBe(false);

    cleanup();
    chatContext.current.activityLog = { expandWhileRunning: true };
    const view = render(<ActivityLog active steps={steps} />);
    expect(root()!.open).toBe(true);
    // Collapses again when the turn is over.
    view.rerender(
      <ActivityLog active={false} steps={[steps[0]!, { ...steps[1]!, status: 'done' }]} />,
    );
    expect(root()!.open).toBe(false);
  });

  it('keeps a log the user closed during the run closed', () => {
    chatContext.current.activityLog = { expandWhileRunning: true };
    const steps = [{ id: 'c1', toolName: 'create_team', status: 'running' as const }];
    const view = render(<ActivityLog active steps={steps} />);
    expect(root()!.open).toBe(true);
    root()!.open = false;
    fireEvent(root()!, new Event('toggle'));
    view.rerender(<ActivityLog active steps={[...steps, { id: 'c2', toolName: 'list_tasks', status: 'running' as const }]} />);
    expect(root()!.open).toBe(false);
  });

  it('shows the progress of a running turn only with runningProgress', () => {
    const steps = [
      { id: 'c1', toolName: 'list_tasks', status: 'done' as const },
      { id: 'c2', toolName: 'list_tasks', status: 'expected' as const },
      { id: 'c3', toolName: 'create_team', status: 'running' as const },
    ];
    render(<ActivityLog active steps={steps} />);
    const summary = () => document.querySelector('[data-element="activity-summary"]')!.textContent;
    expect(summary()).toBe('Team anlegen…');

    cleanup();
    chatContext.current.activityLog = { runningProgress: true };
    render(<ActivityLog active steps={steps} />);
    // Only done steps count: the neutral one is not "erledigt".
    expect(summary()).toBe('1 erledigt, Team anlegen…');

    cleanup();
    render(<ActivityLog active steps={[{ id: 'c1', toolName: 'create_team', status: 'running' }]} />);
    // Nothing finished yet: no count.
    expect(summary()).toBe('Team anlegen…');

    cleanup();
    render(<ActivityLog active steps={[{ id: 'c1', toolName: 'create_team', status: 'done' }]} />);
    expect(summary()).toBe('1 erledigt, Arbeitet…');
  });

  it('takes every text of the summary and the steps from the locale', () => {
    chatContext.current.locale = {
      ...deChatLocale,
      activityRunningLabel: '«{label}»',
      activityStepCountLabel: '({count})',
      activitySummarySeparator: ' / ',
    } as unknown as Record<string, string>;
    const view = render(<ActivityLog active steps={[{ id: 'c1', toolName: 'create_team', status: 'running' }]} />);
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent).toBe('«Team anlegen»');
    view.rerender(
      <ActivityLog
        active={false}
        steps={[
          { id: 'c1', toolName: 'list_tasks', status: 'error' },
          { id: 'c2', toolName: 'list_tasks', status: 'error' },
          { id: 'c3', toolName: 'create_team', status: 'declined' },
        ]}
      />,
    );
    expect(document.querySelector('[data-element="activity-summary"]')!.textContent)
      .toBe('2 fehlgeschlagen / 1 abgelehnt');
    expect(rows()[0]!.querySelector('[data-element="count"]')!.textContent).toBe('(2)');
  });

  it('renders the notice through the TurnNotice slot inside the log', () => {
    const seen: unknown[] = [];
    chatContext.current.components = {
      TurnNotice: (props: { text: string; status: string; placement: string }) => {
        seen.push(props);
        return <em data-testid="notice">{props.text}</em>;
      },
    };
    render(
      <ActivityLog
        active={false}
        notice="Gestoppt"
        noticeStatus="aborted"
        steps={[{ id: 'c1', toolName: 'list_tasks', status: 'done' }]}
      />,
    );
    expect(root()!.querySelector('[data-testid="notice"]')!.textContent).toBe('Gestoppt');
    expect(root()!.querySelector('[data-element="activity-notice"]')).toBeNull();
    expect(seen).toEqual([{ text: 'Gestoppt', status: 'aborted', placement: 'log' }]);
  });

  it('has English and German defaults for the layout texts', () => {
    expect(DEFAULT_LOCALE.activityRunningLabel).toBe('{label}…');
    expect(deChatLocale.activityRunningLabel).toBe('{label}…');
    expect(DEFAULT_LOCALE.activityRunningProgressLabel).toBe('{count} done, {label}…');
    expect(deChatLocale.activityRunningProgressLabel).toBe('{count} erledigt, {label}…');
    expect(DEFAULT_LOCALE.activityStepCountLabel).toBe('×{count}');
    expect(deChatLocale.activityStepCountLabel).toBe('×{count}');
    expect(DEFAULT_LOCALE.activitySummarySeparator).toBe(', ');
    expect(deChatLocale.activitySummarySeparator).toBe(', ');
  });

  it('has English defaults for every new text', () => {
    expect(DEFAULT_LOCALE.activityDoneLabel).toBe('{count} steps done');
    expect(DEFAULT_LOCALE.activityDoneOneLabel).toBe('1 step done');
    expect(DEFAULT_LOCALE.activityDeclinedLabel).toBe('{count} declined');
    expect(deChatLocale.activityDeclinedLabel).toBe('{count} abgelehnt');
    expect(DEFAULT_LOCALE.activityExpectedLabel).toBe('{count} without result');
    expect(deChatLocale.activityExpectedLabel).toBe('{count} ohne Ergebnis');
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

describe('ActivityLog and UI action outcomes', () => {
  const details = () => rows().map((row) => row.querySelector('[data-element="detail"]')?.textContent ?? null);

  it('names each reported outcome in the chat language, without folding different ones', () => {
    render(
      <ActivityLog
        active
        steps={[
          { id: 'c1', toolName: 'ui_navigate', status: 'waiting', uiOutcome: 'pending' },
          { id: 'c2', toolName: 'ui_navigate', status: 'error', uiOutcome: 'rejected-contract' },
          { id: 'c3', toolName: 'ui_navigate', status: 'error', uiOutcome: 'rejected-handler' },
          { id: 'c4', toolName: 'ui_navigate', status: 'error', uiOutcome: 'unavailable' },
          { id: 'c5', toolName: 'ui_navigate', status: 'error', uiOutcome: 'failed' },
          { id: 'c6', toolName: 'ui_navigate', status: 'done', uiOutcome: 'initiated' },
          { id: 'c7', toolName: 'ui_navigate', status: 'done', uiOutcome: 'unconfirmed' },
          { id: 'c8', toolName: 'ui_navigate', status: 'done' },
        ]}
      />,
    );
    expect(details()).toEqual([
      'Wartet auf die App',
      'Von der App abgelehnt (ungültige Eingabe)',
      'Von der App nicht ausgeführt',
      'Auf dieser Seite nicht verfügbar',
      'In der App fehlgeschlagen',
      'Gestartet',
      'Nicht bestätigt',
      null,
    ]);
  });

  it('shows a result still waiting after its turn ended as not confirmed', () => {
    chatContext.current.locale = DEFAULT_LOCALE as unknown as Record<string, string>;
    render(<ActivityLog active={false} steps={[{ id: 'c1', toolName: 'ui_navigate', status: 'waiting', uiOutcome: 'pending' }]} />);
    expect(details()).toEqual(['Not confirmed']);
    expect(rows()[0]!.getAttribute('data-status')).toBe('done');
  });
});
