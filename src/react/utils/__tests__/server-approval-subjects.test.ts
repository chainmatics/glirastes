import { describe, expect, it } from 'vitest';
import { APPROVAL_SUBJECTS_PART_TYPE, parseApprovalSubjectsPart } from '../../../contracts/approval-subject.js';
import type { ApprovalSubject } from '../../types.js';
import {
  applyServerApprovalSubjects,
  findApprovalSubjectsPart,
  mergeServerApprovalSubjects,
  serverSubjectNames,
} from '../server-approval-subjects.js';

function part(data: Record<string, unknown>) {
  return { type: APPROVAL_SUBJECTS_PART_TYPE, id: String(data.toolCallId), data: { v: 1, ...data } };
}

function server(subjects: unknown[], extra: Record<string, unknown> = {}) {
  return parseApprovalSubjectsPart({ v: 1, toolCallId: 'call-1', subjects, ...extra })!;
}

const found = {
  type: 'playlist', role: 'target', id: 'p1', ids: { playlist_id: 'p1' }, path: 'playlist_id',
  status: 'named', check: 'found', name: 'Abend-Promos', idKind: 'opaque',
};

describe('serverSubjectNames', () => {
  it('names an id only when no other subject of the call shares it (playlist 3 and user 3)', () => {
    const playlist = { ...found, id: '3', ids: { playlist_id: '3' }, name: 'Lobby Loop' };
    const user = { ...found, type: 'user', id: '3', ids: { user_id: '3' }, path: 'user_id', name: 'Linus Torvalds' };
    expect(serverSubjectNames(server([playlist, user])).has('3')).toBe(false);
    expect(serverSubjectNames(server([playlist])).get('3')).toBe('Lobby Loop');
  });
});

describe('findApprovalSubjectsPart', () => {
  it('finds the part of the call by its toolCallId and ignores the rest', () => {
    const parts = [
      { type: 'text', text: 'x' },
      part({ toolCallId: 'other', subjects: [] }),
      { type: APPROVAL_SUBJECTS_PART_TYPE, id: 'call-1', data: { v: 2, toolCallId: 'call-1', subjects: [] } },
      part({ toolCallId: 'call-1', subjects: [found] }),
    ];
    expect(findApprovalSubjectsPart(parts, 'call-1')?.subjects[0]?.name).toBe('Abend-Promos');
    expect(findApprovalSubjectsPart(parts, 'missing')).toBeUndefined();
    expect(findApprovalSubjectsPart(parts, undefined)).toBeUndefined();
  });

  it('matches by the parsed data, not by the part id', () => {
    const parts = [{ type: APPROVAL_SUBJECTS_PART_TYPE, id: 'call-1', data: { v: 1, toolCallId: 'call-2', subjects: [] } }];
    expect(findApprovalSubjectsPart(parts, 'call-1')).toBeUndefined();
    expect(findApprovalSubjectsPart(parts, 'call-2')).toBeDefined();
  });
});

describe('mergeServerApprovalSubjects', () => {
  const history: ApprovalSubject[] = [
    { path: 'playlist_id', id: 'p1', status: 'named', name: 'Alt', label: 'Playlist', type: 'playlist', role: 'target', idKind: 'opaque', provenance: 'tool-result' },
    { path: 'folderId', id: 'f9', status: 'unknown', label: 'Folder' },
  ];

  it('returns the browser subjects untouched without a server part', () => {
    const merged = mergeServerApprovalSubjects(history, undefined);
    expect(merged.subjects).toBe(history);
    expect(merged).toEqual({ subjects: history });
  });

  it('replaces the browser subject of the path with the server subject and marks the rest as history', () => {
    const merged = mergeServerApprovalSubjects(history, server([found]));
    expect(merged.subjects).toEqual([
      {
        path: 'playlist_id', id: 'p1', status: 'named', name: 'Abend-Promos', label: 'Playlist', type: 'playlist', role: 'target',
        idKind: 'opaque', ids: { playlist_id: 'p1' }, source: 'server', check: 'found',
      },
      { path: 'folderId', id: 'f9', status: 'unknown', label: 'Folder', source: 'history' },
    ]);
  });

  it('maps a composite server subject onto every argument path', () => {
    const browser: ApprovalSubject[] = [
      { path: 'channel', id: 'c1', status: 'unknown', label: 'Channel' },
      { path: 'rev', id: '3', status: 'unknown', label: 'Rev' },
      { path: 'note_id', id: 'n1', status: 'unknown', label: 'Note' },
    ];
    const merged = mergeServerApprovalSubjects(browser, server([{
      type: 'version', role: 'target', id: 'c1/3', ids: { channel: 'c1', rev: '3' }, path: 'channel,rev',
      status: 'seen', check: 'found', fallbackField: 'versionNumber', fallbackValue: 3, idKind: 'opaque',
    }]));
    expect(merged.subjects.map((subject) => subject.path)).toEqual(['channel,rev', 'note_id']);
    expect(merged.subjects[0]).toMatchObject({
      status: 'seen', label: 'Version', fallbackField: 'versionNumber', fallbackValue: 3, fallback: 'Version number 3', source: 'server',
    });
  });

  it('gives a server ambiguous subject its candidates with the type label', () => {
    const merged = mergeServerApprovalSubjects([], server([{
      ...found, status: 'ambiguous', name: undefined, candidates: ['Morgen-Mix', 'Morgen-Mix (Kopie)'],
    }]));
    expect(merged.subjects[0]).toMatchObject({
      status: 'ambiguous', source: 'server', check: 'found',
      candidates: [{ label: 'Playlist', name: 'Morgen-Mix' }, { label: 'Playlist', name: 'Morgen-Mix (Kopie)' }],
      names: ['Morgen-Mix', 'Morgen-Mix (Kopie)'],
    });
    expect(merged.subjects[0]!.name).toBeUndefined();
  });

  it('keeps the browser name as fallback display of an unchecked subject', () => {
    const unchecked = { ...found, status: 'unknown', check: 'unchecked', reason: 'timeout', name: undefined };
    const merged = mergeServerApprovalSubjects(history, server([unchecked]));
    expect(merged.subjects[0]).toEqual({
      path: 'playlist_id', id: 'p1', status: 'named', name: 'Alt', label: 'Playlist', type: 'playlist', role: 'target',
      idKind: 'opaque', provenance: 'tool-result', ids: { playlist_id: 'p1' }, source: 'history', check: 'unchecked', reason: 'timeout',
    });
  });

  it('shows an unchecked subject without a browser subject as unknown from the server', () => {
    const merged = mergeServerApprovalSubjects([], server([{ ...found, status: 'unknown', check: 'unchecked', reason: 'forbidden', name: undefined }]));
    expect(merged.subjects[0]).toEqual({
      path: 'playlist_id', id: 'p1', status: 'unknown', label: 'Playlist', type: 'playlist', role: 'target', idKind: 'opaque',
      ids: { playlist_id: 'p1' }, source: 'server', check: 'unchecked', reason: 'forbidden',
    });
  });

  it('puts the preview on the call and on the first target server subject, labels in the chat language', () => {
    const parent = { ...found, role: 'parent', id: 'f1', ids: { folder_id: 'f1' }, path: 'folder_id', type: 'folder', name: 'Ordner' };
    const merged = mergeServerApprovalSubjects([], server([parent, found], {
      preview: {
        check: 'found',
        fields: [
          { key: 'impact.devices', label: { en: 'Devices', de: 'Geräte' }, value: 12, format: 'count' },
          { key: 'summary.title', label: 'Title', value: 'Lobby' },
        ],
      },
    }), 'de-AT');
    const preview = [
      { key: 'impact.devices', label: 'Geräte', value: 12, format: 'count' },
      { key: 'summary.title', label: 'Title', value: 'Lobby' },
    ];
    expect(merged.preview).toEqual(preview);
    expect(merged.previewCheck).toBe('found');
    expect(merged.subjects[0]!.preview).toBeUndefined();
    expect(merged.subjects[1]!.preview).toEqual(preview);
  });

  it('carries no preview values when the server could not load the preview', () => {
    const merged = mergeServerApprovalSubjects([], server([found], { preview: { check: 'unchecked', reason: 'timeout', fields: [] } }));
    expect(merged.previewCheck).toBe('unchecked');
    expect(merged.preview).toBeUndefined();
    expect(merged.subjects[0]!.preview).toBeUndefined();
  });
});

describe('applyServerApprovalSubjects', () => {
  const described = { id: 'a1', toolName: 't', args: {}, messageId: 'm' };

  it('is the same object without a part and without subjects', () => {
    expect(applyServerApprovalSubjects(described, { subjects: [] })).toBe(described);
    const subjects: ApprovalSubject[] = [{ path: 'id', id: 'x', status: 'unknown' }];
    expect(applyServerApprovalSubjects(described, { subjects })).toEqual({ ...described, subjects });
  });

  it('adds the preview of the call', () => {
    const merged = mergeServerApprovalSubjects([], server([], { preview: { check: 'unchecked', fields: [] } }));
    expect(applyServerApprovalSubjects(described, merged)).toEqual({ ...described, previewCheck: 'unchecked' });
  });
});
