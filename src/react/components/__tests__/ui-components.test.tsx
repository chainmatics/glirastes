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
import { RecordingBar } from '../recording-bar.js';

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
      sessionArchiveMessage: '"{title}" wird archiviert.',
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
          messageId: 'message-1',
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

  it('replaces the full input width with a waveform and the live transcript while recording', () => {
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript="Interim text stays out of the editor"
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const bar = document.querySelector<HTMLElement>(
      '[data-component="recording-bar"]',
    );
    expect(bar?.style.width).toBe('100%');
    expect(document.querySelector('[data-element="waveform"]')).toBeTruthy();
    const interim = document.querySelector('[data-part="interim-transcript"]');
    expect(interim?.textContent).toBe('Interim text stays out of the editor');
    expect(interim?.getAttribute('aria-live')).toBe('polite');
  });

  it('shows only the newest words of a long interim transcript', () => {
    const long = `${'alt '.repeat(40)}neueste Worte`;
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript={long}
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const interim = document.querySelector('[data-part="interim-transcript"]')!;
    expect(interim.textContent!.length).toBe(80);
    expect(interim.textContent!.startsWith('…')).toBe(true);
    expect(interim.textContent!.endsWith('neueste Worte')).toBe(true);
    expect(interim.getAttribute('title')).toBe(long.trim());
  });

  it('clips the oldest side of a narrow transcript slot so the newest words stay visible', () => {
    // jsdom has no layout; real Chrome measures the result in
    // tests/recording-bar-browser.test.mjs. Here: a Latin line runs opposite
    // to its text, which is isolated as left-to-right so punctuation stays put.
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript="hallo welt aus dem browser."
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const interim = document.querySelector<HTMLElement>('[data-part="interim-transcript"]')!;
    expect(interim.style.direction).toBe('rtl');
    expect(interim.style.textAlign).toBe('left');
    expect(interim.style.textOverflow).toBe('ellipsis');
    const text = interim.querySelector('bdi');
    expect(text?.getAttribute('dir')).toBe('ltr');
    expect(text?.textContent).toBe('hallo welt aus dem browser.');
  });

  it('flips both directions for a right-to-left script so its newest words stay visible too', () => {
    render(
      <RecordingBar
        variant="inline"
        isConnecting={false}
        stream={null}
        transcript="123 مرحبا بالعالم"
        onCancel={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const interim = document.querySelector<HTMLElement>('[data-part="interim-transcript"]')!;
    expect(interim.style.direction).toBe('ltr');
    expect(interim.querySelector('bdi')?.getAttribute('dir')).toBe('rtl');
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

  it('renames a local session from the switcher', async () => {
    render(<SessionSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Sitzung/ }));
    const olderRow = screen.getByText('Ältere Sitzung').closest('[role="option"]');
    const editButton = olderRow?.querySelector<HTMLButtonElement>(
      '[data-element="row-edit"]',
    );
    expect(editButton).toBeTruthy();
    fireEvent.click(editButton!);

    const input = screen.getByPlaceholderText('Neuer Name');
    fireEvent.change(input, { target: { value: 'Planung' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(componentSpies.renameSession)
        .toHaveBeenCalledWith('older', 'Planung');
    });
  });

  it('confirms deletion with localized session copy', async () => {
    render(<SessionSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Sitzung/ }));
    const olderRow = screen.getByText('Ältere Sitzung').closest('[role="option"]');
    const deleteButton = olderRow?.querySelector<HTMLButtonElement>(
      '[data-element="row-delete"]',
    );
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton!);

    expect(screen.getByText('Sitzung wirklich löschen?')).toBeTruthy();
    expect(screen.getByText('"Ältere Sitzung" wird archiviert.')).toBeTruthy();
    expect(screen.queryByText(/will be archived/)).toBeNull();

    const confirmButton = screen.getByRole('alertdialog')
      .querySelector<HTMLButtonElement>('[data-element="confirm"]');
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton!);
    await waitFor(() => {
      expect(componentSpies.removeSession).toHaveBeenCalledWith('older');
    });
  });
});
