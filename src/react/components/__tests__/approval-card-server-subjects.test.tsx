// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import type { ApprovalSubject, ChatLocale, PendingApproval } from '../../types.js';
import { ApprovalCard } from '../approval-card.js';
import { BulkApprovalCard } from '../bulk-approval-card.js';

const context: { locale: ChatLocale; language?: string } = { locale: DEFAULT_LOCALE };

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({ classNames: {}, toolLabels: {}, ...context }),
}));

beforeEach(() => {
  context.locale = DEFAULT_LOCALE;
  context.language = undefined;
});
afterEach(cleanup);

function approval(partial: Partial<PendingApproval>): PendingApproval {
  return { id: 'a1', toolName: 'playlists_delete', args: {}, messageId: 'm', description: 'Delete playlist', ...partial };
}

function renderCard(a: PendingApproval) {
  return render(<ApprovalCard approval={a} onApprove={vi.fn()} onReject={vi.fn()} />);
}

const named: ApprovalSubject = {
  path: 'playlist_id', id: 'p1', status: 'named', name: 'Abend-Promos', label: 'Playlist', type: 'playlist', role: 'target',
  idKind: 'opaque', ids: { playlist_id: 'p1' }, source: 'server', check: 'found',
};
const unchecked: ApprovalSubject = {
  path: 'playlist_id', id: 'p1', status: 'unknown', label: 'Playlist', type: 'playlist', role: 'target',
  idKind: 'opaque', ids: { playlist_id: 'p1' }, source: 'server', check: 'unchecked', reason: 'timeout',
};

describe('ApprovalCard with server subjects', () => {
  it('shows the server name like a known name, without a warning', () => {
    const { container } = renderCard(approval({ subjects: [named] }));
    expect(container.querySelector('[data-subject]')!.textContent).toBe('PlaylistAbend-Promos');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells "could not be checked" apart from "id unknown"', () => {
    expect(DEFAULT_LOCALE.approvalSubjectUncheckedWarning).not.toBe(DEFAULT_LOCALE.approvalUnknownIdWarning);
    expect(deChatLocale.approvalSubjectUncheckedWarning).not.toBe(deChatLocale.approvalUnknownIdWarning);

    renderCard(approval({ subjects: [unchecked] }));
    let warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('Playlist p1 could not be checked right now.');
    expect(warning.textContent).not.toContain(DEFAULT_LOCALE.approvalUnknownIdWarning);
    expect(warning.querySelector('[data-check="unchecked"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Confirm/ }).getAttribute('aria-describedby')).toBe(warning.id);
    cleanup();

    renderCard(approval({ subjects: [{ path: 'playlist_id', id: 'p1', status: 'unknown', label: 'Playlist' }] }));
    warning = screen.getByRole('alert');
    expect(warning.textContent).toContain(DEFAULT_LOCALE.approvalUnknownIdWarning);
    expect(warning.textContent).not.toContain('could not be checked');
    expect(warning.querySelector('[data-check="unchecked"]')).toBeNull();
  });

  it('keeps the history name of an unchecked subject and still warns', () => {
    const { container } = renderCard(approval({ subjects: [{ ...unchecked, status: 'named', name: 'Alt', source: 'history' }] }));
    expect(container.querySelector('[data-subject]')!.textContent).toBe('PlaylistAlt');
    expect(screen.getByRole('alert').textContent).toContain('Playlist p1 could not be checked right now.');
    expect(screen.getByRole('alert').textContent).not.toContain(DEFAULT_LOCALE.approvalUnknownIdWarning);
  });

  it('warns in German', () => {
    context.locale = deChatLocale;
    renderCard(approval({ subjects: [unchecked] }));
    expect(screen.getByRole('alert').textContent).toContain('Playlist p1 konnte gerade nicht geprüft werden.');
  });

  it('renders a hostile server name as plain sanitized text', () => {
    const hostile = 'A\u202Eevil\nnext <b>x</b>';
    const { container } = renderCard(approval({ subjects: [{ ...named, name: hostile }] }));
    const line = container.querySelector('[data-subject]')!;
    expect(line.textContent).toBe('PlaylistA evil next <b>x</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.innerHTML).not.toContain('\u202E');
    expect(container.innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('shows a server seen subject with its fallback and without the conversation note', () => {
    const { container } = renderCard(approval({ subjects: [{
      ...named, status: 'seen', name: undefined, fallback: 'Version number 3', fallbackField: 'versionNumber', fallbackValue: 3,
    }] }));
    const line = container.querySelector('[data-status="seen"]')!;
    expect(line.textContent).toBe('PlaylistVersion number 3');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the candidates of a server ambiguous subject', () => {
    renderCard(approval({ subjects: [{
      ...named, status: 'ambiguous', name: undefined, names: ['Mix', 'Mix 2'],
      candidates: [{ label: 'Playlist', name: 'Mix' }, { label: 'Playlist', name: 'Mix 2' }],
    }] }));
    expect(screen.getByRole('alert').textContent).toContain('This id came up with different names: Mix, Mix 2.');
  });

  it('shows a quiet note for a reference the server did not check', () => {
    const { container } = renderCard(approval({ subjects: [
      named,
      { path: 'folder_id', id: 'f9', status: 'unknown', label: 'Folder', role: 'reference', type: 'folder', source: 'history' },
    ] }));
    const line = container.querySelector('[data-status="reference"]')!;
    expect(line.textContent).toBe('Folderf9Referenced, not checked.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still warns about a reference without server data in an app without a server part', () => {
    renderCard(approval({ subjects: [{ path: 'folder_id', id: 'f9', status: 'unknown', label: 'Folder', role: 'reference', type: 'folder' }] }));
    expect(screen.getByRole('alert').textContent).toContain(DEFAULT_LOCALE.approvalUnknownIdWarning);
  });

  it('shows up to three preview rows, a count as number and a date in the chat language', () => {
    context.language = 'de-DE';
    const { container } = renderCard(approval({
      subjects: [named],
      preview: [
        { key: 'impact.devices', label: 'Devices', value: 12, format: 'count' },
        { key: 'summary.date', label: 'Since', value: '2026-03-04T10:00:00Z', format: 'date' },
        { key: 'summary.title', label: 'Title\u202E', value: 'Lobby\nLoop' },
        { key: 'summary.more', label: 'More', value: true },
      ],
    }));
    const rows = [...container.querySelectorAll('[data-preview=""]')].map((row) => row.textContent);
    expect(rows).toEqual(['Devices12', `Since${new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date('2026-03-04T10:00:00Z'))}`, 'TitleLobby Loop']);
    expect(rows[1]).toContain('2026');
  });

  it('shows a quiet note when the preview could not be loaded', () => {
    const { container } = renderCard(approval({ subjects: [named], previewCheck: 'unchecked' }));
    expect(container.querySelector('[data-preview="unchecked"]')!.textContent).toBe('The preview could not be loaded.');
    expect(container.querySelector('[data-preview=""]')).toBeNull();
  });
});

describe('BulkApprovalCard with server subjects', () => {
  it('names each call and collects the unchecked ones into one plural warning', () => {
    const { container } = render(
      <BulkApprovalCard
        toolName="playlists_delete"
        approvals={[
          approval({ id: 'a1', subjects: [named] }),
          approval({ id: 'a2', subjects: [{ ...unchecked, id: 'p2' }] }),
          approval({ id: 'a3', subjects: [{ ...unchecked, id: 'p3', label: 'Version' }] }),
        ]}
        onApproveAll={vi.fn()}
        onRejectAll={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-element="detail-value"]')!.textContent).toBe('Abend-Promos');
    const warning = screen.getByRole('alert');
    expect(warning.querySelectorAll('[data-check="unchecked"]')).toHaveLength(1);
    expect(warning.textContent).toContain('These could not be checked right now: Playlist p2, Version p3.');
  });
});
