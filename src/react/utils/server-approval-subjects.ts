import {
  APPROVAL_SUBJECTS_PART_TYPE,
  parseApprovalSubjectsPart,
  type ApprovalSubjectsPartData,
  type ServerApprovalSubject,
} from '../../contracts/approval-subject.js';
import { fallbackText } from '../../contracts/entity-identity.js';
import { resolveLocalizedText } from '../../contracts/localized-text.js';
import type { ApprovalPreviewItem, ApprovalSubject, PendingApproval } from '../types.js';
import { entityTypeLabel } from './approval-subjects.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The server's subjects of one call (`data-approval-subjects`) among the parts
 * of its message, matched by the parsed `toolCallId`; undefined when there is
 * none or it does not parse. The part comes from the client's history, so it
 * is read through the strict parser like any client data.
 */
export function findApprovalSubjectsPart(
  parts: ReadonlyArray<unknown>,
  toolCallId: string | undefined,
): ApprovalSubjectsPartData | undefined {
  if (!toolCallId) return undefined;
  for (const part of parts) {
    if (!isRecord(part) || part.type !== APPROVAL_SUBJECTS_PART_TYPE) continue;
    const data = parseApprovalSubjectsPart(part.data);
    if (data?.toolCallId === toolCallId) return data;
  }
  return undefined;
}

/** The subjects of a call with the server's merged in, and the call's preview. */
export interface MergedApprovalSubjects {
  subjects: ApprovalSubject[];
  preview?: ApprovalPreviewItem[];
  previewCheck?: 'found' | 'unchecked';
}

/** The argument paths a server subject covers: its own (`channel,rev`) and each part of a composite key. */
function pathsOf(subject: ServerApprovalSubject): string[] {
  return subject.path.includes(',') ? [subject.path, ...subject.path.split(',')] : [subject.path];
}

function fromServer(subject: ServerApprovalSubject, label: string | undefined): ApprovalSubject {
  const fallback = subject.fallbackField !== undefined && subject.fallbackValue !== undefined
    ? { fallback: fallbackText(subject.fallbackField, subject.fallbackValue), fallbackField: subject.fallbackField, fallbackValue: subject.fallbackValue }
    : {};
  const candidates = subject.candidates && subject.candidates.length > 0 ? [...subject.candidates] : undefined;
  return {
    path: subject.path,
    id: subject.id,
    status: subject.status,
    ...(subject.name !== undefined ? { name: subject.name } : {}),
    ...(candidates ? { names: candidates, candidates: candidates.map((name) => ({ label: label ?? subject.type, name })) } : {}),
    ...(label ? { label } : {}),
    ...fallback,
    type: subject.type,
    role: subject.role,
    idKind: subject.idKind,
    ids: { ...subject.ids },
    source: 'server',
    check: subject.check,
    ...(subject.reason !== undefined ? { reason: subject.reason } : {}),
  };
}

/**
 * Merges the server's subjects of a call over the browser's heuristic (the
 * fallback only):
 * - a server subject replaces the browser subject(s) of its argument path, a
 *   composite key's of every one of its paths;
 * - `check: 'found'`: the server's name, status and identity (`source: 'server'`);
 * - `check: 'unchecked'`: `source: 'server'`, status `unknown`; when the browser
 *   has a subject for the same path and id, its name and status stay as the
 *   fallback display (`source: 'history'`, still `check: 'unchecked'`);
 * - the browser's other subjects stay, marked `source: 'history'`.
 * The preview goes on the call and on the first `target` subject the server
 * sent, labels resolved for `language`. Without a part, the browser subjects
 * are returned as they are (the same array).
 */
export function mergeServerApprovalSubjects(
  browser: ApprovalSubject[],
  part: ApprovalSubjectsPartData | undefined,
  language?: string,
): MergedApprovalSubjects {
  if (!part) return { subjects: browser };
  const covered = new Set(part.subjects.flatMap(pathsOf));
  const fromPart = part.subjects.map((subject) => {
    const label = entityTypeLabel(subject.type);
    if (subject.check === 'found') return fromServer(subject, label);
    const shown = browser.find((candidate) => candidate.path === subject.path && candidate.id === subject.id);
    if (!shown) return fromServer(subject, label);
    return {
      ...shown,
      ...(label ? { label } : {}),
      type: subject.type,
      role: subject.role,
      idKind: subject.idKind,
      ids: { ...subject.ids },
      source: 'history' as const,
      check: 'unchecked' as const,
      ...(subject.reason !== undefined ? { reason: subject.reason } : {}),
    };
  });
  const rest = browser
    .filter((subject) => !covered.has(subject.path))
    .map((subject) => ({ ...subject, source: subject.source ?? 'history' as const }));

  const merged: MergedApprovalSubjects = { subjects: [...fromPart, ...rest] };
  if (part.preview) {
    merged.previewCheck = part.preview.check;
    if (part.preview.check === 'found' && part.preview.fields.length > 0) {
      const preview = part.preview.fields.map((field): ApprovalPreviewItem => ({
        key: field.key,
        label: resolveLocalizedText(field.label, language) ?? field.key,
        value: field.value,
        ...(field.format ? { format: field.format } : {}),
      }));
      merged.preview = preview;
      const target = fromPart.findIndex((subject) => subject.role === 'target');
      if (target >= 0) merged.subjects[target] = { ...merged.subjects[target]!, preview };
    }
  }
  return merged;
}

/** The pending approval with the merged subjects and preview; the same object when there is nothing to add. */
export function applyServerApprovalSubjects(described: PendingApproval, merged: MergedApprovalSubjects): PendingApproval {
  if (merged.subjects.length === 0 && !merged.previewCheck) return described;
  return {
    ...described,
    ...(merged.subjects.length > 0 ? { subjects: merged.subjects } : {}),
    ...(merged.preview ? { preview: merged.preview } : {}),
    ...(merged.previewCheck ? { previewCheck: merged.previewCheck } : {}),
  };
}

/**
 * The names the server found for the call's ids, by lower-cased id, for the
 * description's detail lines (`names`): the server's name wins over the history's.
 */
export function serverSubjectNames(part: ApprovalSubjectsPartData | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const subject of part?.subjects ?? []) {
    if (subject.check === 'found' && subject.status === 'named' && subject.name) names.set(subject.id.toLowerCase(), subject.name);
  }
  return names;
}
