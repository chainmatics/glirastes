// @vitest-environment jsdom

import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../approval-card.js';
import { SessionSwitcher } from '../session-switcher.js';
import { SuggestionBar } from '../suggestion-bar.js';

const componentSpies = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  selectSuggestion: vi.fn(),
  switchSession: vi.fn(async () => {}),
  createSession: vi.fn(async () => null),
  removeSession: vi.fn(async () => {}),
  renameSession: vi.fn(async () => {}),
}));

const chatContext = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../../provider/chat-context.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../provider/chat-context.js')
  >('../../provider/chat-context.js');
  return {
    ...actual,
    useChatContext: () => chatContext.current,
  };
});

function resetContext() {
  chatContext.current = {
    classNames: {
      approvalCard: 'approval',
      suggestionChip: 'suggestions',
    },
    components: {},
    locale: {
      cancelButton: 'Abbrechen',
      confirmButton: 'Bestätigen',
      newChatLabel: 'Neuer Chat',
      sessionsLoadingLabel: 'Wird geladen',
      noSessionsLabel: 'Keine Sitzungen',
      renameSessionAriaLabel: 'Sitzung umbenennen',
      renameSessionPlaceholder: 'Neuer Name',
      deleteSessionAriaLabel: 'Sitzung löschen',
      confirmDeleteSessionPrompt: 'Sitzung wirklich löschen?',
    },
    suggestions: {},
    suggestionChips: ['Aufgaben prüfen', 'Dashboard öffnen'],
    selectSuggestion: componentSpies.selectSuggestion,
    sessions: [
      {
        id: 'older',
        title: 'Ältere Sitzung',
        updatedAt: '2026-07-28T12:00:00.000Z',
      },
      {
        id: 'current',
        title: 'Aktuelle Sitzung',
        updatedAt: '2026-07-29T12:00:00.000Z',
      },
    ],
    activeSessionId: 'current',
    sessionsSupported: true,
    isSessionsLoading: false,
    switchSession: componentSpies.switchSession,
    createSession: componentSpies.createSession,
    removeSession: componentSpies.removeSession,
    renameSession: componentSpies.renameSession,
  };
}

describe('Glirastes UI parity components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContext();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders approval detail and routes explicit approve/reject actions', () => {
    render(
      <ApprovalCard
        approval={{
          id: 'approval-1',
          toolName: 'tasks.update',
          description: 'Aufgabe aktualisieren',
          details: ['Titel: Quartalsbericht', 'Hohe Auswirkung'],
          args: {},
        }}
        onApprove={componentSpies.approve}
        onReject={componentSpies.reject}
      />,
    );

    expect(screen.getByText('Aufgabe aktualisieren')).toBeTruthy();
    expect(screen.getByText('Titel')).toBeTruthy();
    expect(screen.getByText('Quartalsbericht')).toBeTruthy();
    expect(screen.getByText('Hohe Auswirkung')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Bestätigen/ }));
    fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ }));

    expect(componentSpies.approve).toHaveBeenCalledWith('approval-1');
    expect(componentSpies.reject).toHaveBeenCalledWith('approval-1');
  });

  it('renders and selects contextual suggestions', () => {
    render(<SuggestionBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Aufgaben prüfen' }));

    expect(componentSpies.selectSuggestion)
      .toHaveBeenCalledWith('Aufgaben prüfen');
    expect(document.querySelector('[data-component="suggestion-bar"]'))
      .toBeTruthy();
  });

  it('renders the active session and switches to another local session', async () => {
    render(<SessionSwitcher formatTimestamp={() => 'Zeit'} />);

    expect(screen.getByText('Aktuelle Sitzung')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Sitzung/ }));

    const olderRow = screen.getByText('Ältere Sitzung').closest('[role="option"]');
    expect(olderRow).toBeTruthy();
    fireEvent.click(olderRow!);

    await waitFor(() => {
      expect(componentSpies.switchSession).toHaveBeenCalledWith('older');
    });
  });

  it('creates a new local session from the switcher', async () => {
    render(<SessionSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Sitzung/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Neuer Chat' }));

    await waitFor(() => {
      expect(componentSpies.createSession)
        .toHaveBeenCalledWith({ title: 'Neuer Chat' });
    });
  });
});
