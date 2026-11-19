import { useId, useState } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { sanitizeSubjectText } from '../../contracts/approval-subject.js';
import type { ApprovalCardProps, ApprovalPreviewItem, ApprovalSubject, ChatLocale, PendingApproval } from '../types.js';

const COLLAPSED_ITEMS = 2;
const MAX_PREVIEW_ROWS = 3;

/**
 * A text of a server subject as the card shows it: looked up, so untrusted,
 * sanitized again (no control or bidi characters, no line breaks) and only
 * ever rendered as a text node. History texts stay as they are.
 */
function subjectText(subject: ApprovalSubject, text: string): string {
  return subject.source === 'server' ? sanitizeSubjectText(text) ?? '' : text;
}

/** An id the server could not check right now (not the same as an unknown id). */
function isUnchecked(subject: ApprovalSubject): boolean {
  return subject.check === 'unchecked';
}

/** A referenced id of a call the server sent subjects for, that it did not look up and no name is known for. */
function isQuietReference(subject: ApprovalSubject): boolean {
  return subject.source === 'history' && subject.check === undefined && subject.role === 'reference' && subject.status === 'unknown';
}

/** A preview value as text: `count` and `number` as the number, `date` a short date in the chat's language. */
export function previewValueText(item: ApprovalPreviewItem, language: string | undefined): string {
  if (item.format === 'date' && typeof item.value !== 'boolean') {
    const date = new Date(item.value);
    if (!Number.isNaN(date.getTime())) {
      try {
        return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    }
  }
  return sanitizeSubjectText(String(item.value)) ?? '';
}
const LONG_TEXT_LENGTH = 100;

function DetailValue({ value, items }: { value: string; items?: string[] }) {
  const { locale } = useChatContext();
  const [expanded, setExpanded] = useState(false);
  const isList = !!items && items.length > COLLAPSED_ITEMS;
  const isLong = !isList && value.length > LONG_TEXT_LENGTH;

  if (!isList && !isLong) {
    return <span data-element="detail-value">{value}</span>;
  }

  const hidden = isList ? items.length - COLLAPSED_ITEMS : 0;
  const toggleLabel = expanded
    ? locale.showLessLabel
    : isList
      ? locale.showAllItemsLabel.replace('{count}', String(items.length))
      : locale.showMoreLabel;

  return (
    <span data-element="detail-value" data-expanded={expanded ? '' : undefined}>
      {isList && expanded ? (
        <ul data-element="detail-items">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : isList ? (
        <span data-element="detail-summary">
          {items.slice(0, COLLAPSED_ITEMS).join(', ')} +{hidden} {locale.moreItemsLabel}
        </span>
      ) : (
        <span data-element="detail-text" data-collapsed={expanded ? undefined : ''}>
          {value}
        </span>
      )}
      <button
        type="button"
        data-element="detail-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {toggleLabel}
      </button>
    </span>
  );
}

/** A named id line: label and the names shown for the ids under one argument. */
interface SubjectLine {
  label: string;
  names: string[];
}

/**
 * The names of the call's ids, one line per argument, leaving out a name the
 * detail lines already show (an app's `nameLabels`, or the call's own text).
 */
export function approvalSubjectLines(approval: PendingApproval, locale: ChatLocale): SubjectLine[] {
  const lines = new Map<string, SubjectLine>();
  const shown = (name: string) => (approval.details ?? []).some((detail) => detail.endsWith(`: ${name}`));
  for (const subject of approval.subjects ?? []) {
    if (subject.status !== 'named' || !subject.name) continue;
    const name = subjectText(subject, subject.name);
    if (!name || shown(name)) continue;
    const line = lines.get(subject.path) ?? { label: subjectText(subject, subject.label ?? locale.approvalTargetLabel), names: [] };
    if (!line.names.includes(name)) line.names.push(name);
    lines.set(subject.path, line);
  }
  return [...lines.values()];
}

/**
 * The ids of the call that get a warning: no single known name and not seen
 * as a record id in this conversation (`unknown`, `ambiguous`), or one the
 * server could not check right now (`check: 'unchecked'`).
 */
export function flaggedApprovalSubjects(approvals: ReadonlyArray<PendingApproval>): ApprovalSubject[] {
  return approvals.flatMap((approval) => (approval.subjects ?? [])
    .filter((subject) => isUnchecked(subject)
      || (subject.status === 'unknown' && subject.idKind !== 'speaking' && !isQuietReference(subject))
      || subject.status === 'ambiguous'));
}

/** The ids a tool result of this conversation carried without a name: shown neutrally, no warning. */
function seenApprovalSubjects(approval: PendingApproval): ApprovalSubject[] {
  return (approval.subjects ?? []).filter((subject) => subject.status === 'seen');
}

/**
 * The warning for ids this conversation showed no name (or different names)
 * for. The id itself is shown so the person approving can check it; colour is
 * not the only cue (icon and text), and the approve button points to it via
 * `aria-describedby`.
 */
export function ApprovalIdWarning({ id, subjects }: { id: string; subjects: ReadonlyArray<ApprovalSubject> }) {
  const { locale } = useChatContext();
  // A speaking key (declared) the user types needs no warning: it is readable on its own.
  // Not checkable comes first and has its own text: the record may well exist.
  const unchecked = subjects.filter(isUnchecked);
  const unknown = subjects.filter((subject) => !isUnchecked(subject) && !isQuietReference(subject)
    && subject.status === 'unknown' && subject.idKind !== 'speaking');
  const ambiguous = subjects.filter((subject) => !isUnchecked(subject) && subject.status === 'ambiguous');
  const labelOf = (subject: ApprovalSubject) => subjectText(subject, subject.label ?? locale.approvalTargetLabel);
  const uncheckedText = (subject: ApprovalSubject) => `${labelOf(subject)} ${subjectText(subject, subject.id)}`.trim();
  return (
    <div id={id} data-element="id-warning" role="alert">
      <span data-element="warning-icon" aria-hidden="true">{'\u26A0'}</span>
      <div data-element="warning-body">
        {unchecked.length > 0 && (
          <p data-element="warning-text" data-check="unchecked">
            {unchecked.length === 1
              ? locale.approvalSubjectUncheckedWarning
                .replace('{label}', labelOf(unchecked[0]!)).replace('{id}', subjectText(unchecked[0]!, unchecked[0]!.id))
              : locale.approvalSubjectsUncheckedWarning.replace('{ids}', unchecked.map(uncheckedText).join(', '))}
          </p>
        )}
        {unknown.length > 0 && (
          <>
            <p data-element="warning-text">
              {unknown.length === 1 ? locale.approvalUnknownIdWarning : locale.approvalUnknownIdsWarning}
            </p>
            <ul data-element="warning-ids">
              {unknown.map((subject, i) => (
                <li key={i} data-element="detail-line" data-status="unknown">
                  <span data-element="detail-label">{labelOf(subject)}</span>
                  <code data-element="subject-id">{subject.id}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        {ambiguous.map((subject, i) => (
          <div key={i} data-element="warning-ambiguous" data-candidates={subject.candidates ? '' : undefined}>
            <p data-element="warning-text">
              {subject.source === 'server'
                // Several records matched the server's lookup: their names, not kinds.
                ? locale.approvalAmbiguousIdWarning.replace('{names}', (subject.names ?? [])
                  .map((name) => subjectText(subject, name)).join(', '))
                : subject.candidates
                ? locale.approvalCollidingIdWarning.replace('{candidates}', subject.candidates
                  .map((candidate) => (candidate.name ? `${candidate.name} (${candidate.label})` : candidate.label)).join(', '))
                : locale.approvalAmbiguousIdWarning.replace('{names}', (subject.names ?? []).join(', '))}
            </p>
            <ul data-element="warning-ids">
              <li data-element="detail-line" data-status="ambiguous">
                <span data-element="detail-label">{labelOf(subject)}</span>
                {subject.name !== undefined && <span data-element="detail-value">{subjectText(subject, subject.name)}</span>}
                <code data-element="subject-id">{subjectText(subject, subject.id)}</code>
              </li>
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Single tool approval card with rich detail display.
 *
 * Structure: header → details (label/value pairs) → actions (cancel/confirm).
 * Uses `data-state` attribute for styling pending/processing states.
 * Detail lines containing a colon are split into label + value.
 */
export function ApprovalCard({
  approval,
  onApprove,
  onReject,
  className,
  isProcessing,
}: ApprovalCardProps) {
  const { classNames, locale, language } = useChatContext();
  const warningId = useId();
  const subjectLines = approvalSubjectLines(approval, locale);
  const flagged = flaggedApprovalSubjects([approval]);
  const seen = seenApprovalSubjects(approval);
  const references = (approval.subjects ?? []).filter(isQuietReference);
  const preview = (approval.preview ?? []).slice(0, MAX_PREVIEW_ROWS);
  const previewUnchecked = approval.previewCheck === 'unchecked';
  const hasDetails = subjectLines.length > 0 || seen.length > 0 || references.length > 0 || preview.length > 0
    || previewUnchecked || (approval.details?.length ?? 0) > 0;

  return (
    <div
      className={className ?? classNames.approvalCard}
      data-component="approval-card"
      data-tool={approval.toolName}
      data-state={isProcessing ? 'processing' : 'pending'}
      data-warning={flagged.length > 0 ? '' : undefined}
    >
      {/* Header */}
      <div data-element="header">
        <span data-element="description">
          {approval.description ?? approval.toolName}
        </span>
      </div>

      {/* Details */}
      {hasDetails && (
        <div data-element="details">
          {/* Names of the call's ids, from the browser's own history: what the user checks first. */}
          {subjectLines.map((line, i) => (
            <div key={`subject-${i}`} data-element="detail-line" data-subject="">
              <span data-element="detail-label">{line.label}</span>
              <DetailValue value={line.names.join(', ')} items={line.names.length > 1 ? line.names : undefined} />
            </div>
          ))}
          {seen.map((subject, i) => (
            <div key={`seen-${i}`} data-element="detail-line" data-subject="" data-status="seen">
              <span data-element="detail-label">{subjectText(subject, subject.label ?? locale.approvalTargetLabel)}</span>
              {subject.fallback
                ? <span data-element="detail-value">{subjectText(subject, subject.fallback)}</span>
                : <code data-element="subject-id">{subjectText(subject, subject.id)}</code>}
              {/* Found by the server: no note about this conversation. */}
              {subject.source !== 'server' && <span data-element="subject-note">{locale.approvalSeenIdNote}</span>}
            </div>
          ))}
          {references.map((subject, i) => (
            <div key={`reference-${i}`} data-element="detail-line" data-subject="" data-status="reference">
              <span data-element="detail-label">{subject.label ?? locale.approvalTargetLabel}</span>
              <code data-element="subject-id">{subject.id}</code>
              <span data-element="subject-note">{locale.approvalReferenceIdNote}</span>
            </div>
          ))}
          {/* The server's preview: looked-up values, plain text only. */}
          {preview.map((item, i) => (
            <div key={`preview-${i}`} data-element="detail-line" data-preview="">
              <span data-element="detail-label">{sanitizeSubjectText(item.label) ?? item.key}</span>
              <span data-element="detail-value">{previewValueText(item, language)}</span>
            </div>
          ))}
          {previewUnchecked && (
            <div data-element="detail-line" data-preview="unchecked">
              <span data-element="subject-note">{locale.approvalPreviewUncheckedNote}</span>
            </div>
          )}
          {(approval.details ?? []).map((detail, i) => {
            const colonIndex = detail.indexOf(':');
            if (colonIndex === -1) {
              return (
                <div key={i} data-element="detail-line">
                  {detail}
                </div>
              );
            }
            const label = detail.substring(0, colonIndex);
            const value = detail.substring(colonIndex + 1).trim();
            return (
              <div key={i} data-element="detail-line">
                <span data-element="detail-label">{label}</span>
                <DetailValue value={value} items={approval.detailItems?.[i]} />
              </div>
            );
          })}
        </div>
      )}

      {flagged.length > 0 && <ApprovalIdWarning id={warningId} subjects={flagged} />}

      {/* Actions */}
      <div data-element="actions">
        <button
          onClick={() => onReject(approval.id)}
          disabled={isProcessing}
          data-action="reject"
        >
          {'\u2715'} {locale.cancelButton}
        </button>
        <button
          onClick={() => onApprove(approval.id)}
          disabled={isProcessing}
          data-action="approve"
          aria-describedby={flagged.length > 0 ? warningId : undefined}
        >
          {'\u2713'} {approval.confirmText ?? locale.confirmButton}
        </button>
      </div>
    </div>
  );
}
