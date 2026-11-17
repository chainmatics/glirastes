// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import type { PendingApproval } from '../../types.js';
import { createApprovalDescriptionGenerator } from '../../utils/create-approval-description.js';
import { ApprovalCard } from '../approval-card.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({ classNames: {}, locale: deChatLocale }),
}));

const tasks = ['Routineaufgabe Montag', 'Routineaufgabe Dienstag', 'Routineaufgabe Mittwoch', 'Routineaufgabe Donnerstag', 'Routineaufgabe Freitag'];

function approval(partial: Partial<PendingApproval>): PendingApproval {
  return { id: 'a1', toolName: 'delete_tasks', args: {}, messageId: 'm', description: 'Aufgaben löschen', ...partial };
}

function renderCard(a: PendingApproval) {
  return render(<ApprovalCard approval={a} onApprove={vi.fn()} onReject={vi.fn()} />);
}

afterEach(cleanup);

describe('ApprovalCard detail values', () => {
  it('leaves short values untouched', () => {
    renderCard(approval({ details: ['Titel: Bericht'] }));
    expect(screen.getByText('Bericht')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /anzeigen/ })).toBeNull();
  });

  it('does not offer a toggle for a short list', () => {
    renderCard(approval({ details: ['Aufgaben: A, B'], detailItems: [['A', 'B']] }));
    expect(screen.queryByRole('button', { name: /anzeigen/ })).toBeNull();
  });

  it('collapses an array with a count and expands to one item per line', () => {
    const { container } = renderCard(approval({ details: [`Aufgaben: ${tasks.join(', ')}`], detailItems: [tasks] }));
    expect(container.textContent).toContain('Routineaufgabe Montag, Routineaufgabe Dienstag +3 weitere');
    const toggle = screen.getByRole('button', { name: 'Alle 5 anzeigen' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('li').length).toBe(0);

    fireEvent.click(toggle);
    expect(container.querySelectorAll('li').length).toBe(5);
    const less = screen.getByRole('button', { name: 'Weniger anzeigen' });
    expect(less.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(less);
    expect(container.querySelectorAll('li').length).toBe(0);
  });

  it('does not split a comma-joined string that is not an array', () => {
    const { container } = renderCard(approval({ details: [`Aufgaben: ${tasks.join(', ')}`] }));
    expect(container.querySelectorAll('li').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mehr anzeigen' }));
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.textContent).toContain(tasks.join(', '));
  });

  it('wraps long text fully when expanded', () => {
    const long = 'x'.repeat(150);
    const { container } = renderCard(approval({ details: [`Notiz: ${long}`] }));
    expect(container.querySelector('[data-collapsed]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mehr anzeigen' }));
    expect(container.querySelector('[data-collapsed]')).toBeNull();
    expect(container.textContent).toContain(long);
  });
});

describe('createApprovalDescriptionGenerator detailItems', () => {
  it('carries real array values as items, by detail index', () => {
    const gen = createApprovalDescriptionGenerator({ fieldLabels: { titles: 'Aufgaben' } });
    const result = gen('delete_tasks', 'a', { name: 'x', titles: ['a', 'b', 'c'] });
    expect(result.details).toEqual(['name: X', 'Aufgaben: A, B, C']);
    expect(result.detailItems).toEqual([undefined, ['A', 'B', 'C']]);
  });

  it('omits detailItems without arrays', () => {
    const result = createApprovalDescriptionGenerator()('t', 'a', { name: 'x' });
    expect(result.detailItems).toBeUndefined();
  });
});

describe('ApprovalCard ids of the call', () => {
  const PLAYLIST = '14f1e041-4609-4b24-a723-631b133115cc';
  const UNSEEN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

  it('renders a card without ids exactly as before', () => {
    const { container } = renderCard(approval({
      toolName: 'tasks_update', args: { title: 'Bericht' }, description: 'Aufgabe ändern', details: ['Titel: Bericht', 'Priorität: Hoch'],
    }));
    expect(container.innerHTML).toBe(
      '<div data-component="approval-card" data-tool="tasks_update" data-state="pending"><div data-element="header"><span data-element="description">Aufgabe ändern</span></div><div data-element="details"><div data-element="detail-line"><span data-element="detail-label">Titel</span><span data-element="detail-value">Bericht</span></div><div data-element="detail-line"><span data-element="detail-label">Priorität</span><span data-element="detail-value">Hoch</span></div></div><div data-element="actions"><button data-action="reject">✕ Abbrechen</button><button data-action="approve">✓ Bestätigen</button></div></div>',
    );
  });

  it('shows the name of a seen id instead of the id, without a warning', () => {
    const { container } = renderCard(approval({
      args: { id: PLAYLIST },
      details: [],
      subjects: [{ path: 'id', id: PLAYLIST, status: 'named', name: 'Abend-Promos', label: 'Playlist' }],
    }));
    const line = container.querySelector('[data-subject]')!;
    expect(line.querySelector('[data-element="detail-label"]')!.textContent).toBe('Playlist');
    expect(line.querySelector('[data-element="detail-value"]')!.textContent).toBe('Abend-Promos');
    expect(container.textContent).not.toContain(PLAYLIST);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('[data-warning]')).toBeNull();
  });

  it('labels a bare id of unknown type with the German target label', () => {
    const { container } = renderCard(approval({ subjects: [{ path: 'id', id: PLAYLIST, status: 'named', name: 'Abend-Promos' }] }));
    expect(container.querySelector('[data-subject] [data-element="detail-label"]')!.textContent).toBe('Ziel');
  });

  it('does not repeat a name a detail line already shows', () => {
    const { container } = renderCard(approval({
      details: ['Ziel: Abend-Promos'],
      subjects: [{ path: 'id', id: PLAYLIST, status: 'named', name: 'Abend-Promos' }],
    }));
    expect(container.querySelectorAll('[data-subject]').length).toBe(0);
    expect(container.querySelectorAll('[data-element="detail-line"]').length).toBe(1);
  });

  it('warns about an unseen id, shows it and points the approve button to the warning', () => {
    const { container } = renderCard(approval({ subjects: [{ path: 'playlistId', id: UNSEEN, status: 'unknown', label: 'Playlist' }] }));
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('Zu dieser ID ist in dieser Unterhaltung kein Name bekannt. Prüfe sie, bevor du bestätigst.');
    expect(warning.querySelector('[data-element="subject-id"]')!.textContent).toBe(UNSEEN);
    expect(warning.querySelector('[data-element="detail-label"]')!.textContent).toBe('Playlist');
    expect(warning.querySelector('[data-element="warning-icon"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-component="approval-card"]')!.hasAttribute('data-warning')).toBe(true);
    const approve = screen.getByRole('button', { name: /Bestätigen/ });
    expect(approve.getAttribute('aria-describedby')).toBe(warning.id);
    expect(warning.id).not.toBe('');
  });

  it('handles several ids and an id array: names the seen ones, warns about the others in plural', () => {
    const { container } = renderCard(approval({
      subjects: [
        { path: 'playlistId', id: PLAYLIST, status: 'named', name: 'Abend-Promos', label: 'Playlist' },
        { path: 'trackIds', id: 't-1', status: 'named', name: 'Intro', label: 'Tracks' },
        { path: 'trackIds', id: 't-2', status: 'named', name: 'Outro', label: 'Tracks' },
        { path: 'trackIds', id: 't-3', status: 'unknown', label: 'Tracks' },
        { path: 'folderId', id: 'f-9', status: 'unknown', label: 'Folder' },
      ],
    }));
    const lines = [...container.querySelectorAll('[data-subject]')].map((line) => line.textContent);
    expect(lines).toEqual(['PlaylistAbend-Promos', 'TracksIntro, Outro']);
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('Zu diesen IDs sind in dieser Unterhaltung keine Namen bekannt.');
    expect([...warning.querySelectorAll('[data-element="subject-id"]')].map((id) => id.textContent)).toEqual(['t-3', 'f-9']);
  });

  it('flags an id shown with different names, with the latest name and the id', () => {
    renderCard(approval({
      subjects: [{ path: 'userId', id: '7', status: 'ambiguous', name: 'Vertrieb', names: ['Vertrieb', 'Ada'], label: 'User' }],
    }));
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('Diese ID kam mit verschiedenen Namen vor: Vertrieb, Ada. Prüfe sie, bevor du bestätigst.');
    expect(warning.querySelector('[data-element="detail-value"]')!.textContent).toBe('Vertrieb');
    expect(warning.querySelector('[data-element="subject-id"]')!.textContent).toBe('7');
  });
});
