import { useChatContext } from '../provider/chat-context.js';
import { sanitizeSubjectText } from '../../contracts/approval-subject.js';
import type { ApprovalEntryProps, ApprovalOutcome, ApprovalSubject, ChatLocale } from '../types.js';
import { approvalSubjectLines, previewValueText } from './approval-card.js';
import { fillTemplate } from '../utils/fill-template.js';
import { StatusIcon, type StatusIconKind } from './status-icon.js';

const OUTCOME_ICONS: Record<ApprovalOutcome, StatusIconKind> = {
  open: 'pending',
  running: 'spinner',
  done: 'check',
  failed: 'error',
  expected: 'notice',
  declined: 'declined',
  'not-run': 'notice',
};

/** The locale text of an outcome. */
export function approvalOutcomeText(outcome: ApprovalOutcome, locale: ChatLocale): string {
  switch (outcome) {
    case 'open':
      return locale.activityWaitingLabel;
    case 'running':
      return locale.approvalEntryRunningLabel;
    case 'done':
      return locale.approvalEntryDoneLabel;
    case 'failed':
      return locale.approvalEntryFailedLabel;
    case 'expected':
      return locale.approvalEntryExpectedLabel;
    case 'declined':
      return locale.approvalEntryDeclinedLabel;
    default:
      return locale.approvalEntryNotRunLabel;
  }
}

/**
 * Lasting entry of a decided approval at its tool part
 * (`approvalDisplay.decided: 'entry'`): what the card asked, the names of
 * the ids it named and what became of it. Styles through
 * `data-component="approval-entry"`, `data-decision` and `data-outcome`.
 */
export function ApprovalEntry({ approval }: ApprovalEntryProps) {
  const { locale, language } = useChatContext();
  const lines = approvalSubjectLines(
    { id: approval.approvalId, toolName: approval.toolName, args: {}, messageId: '', ...(approval.details ? { details: approval.details } : {}), ...(approval.subjects ? { subjects: approval.subjects } : {}) },
    locale,
  );
  // The server's view of the call (only with a declaration): what it could not check, and its preview.
  const unchecked = (approval.subjects ?? []).filter((subject) => subject.check === 'unchecked');
  const labelOf = (subject: ApprovalSubject) => sanitizeSubjectText(subject.label ?? locale.approvalTargetLabel) ?? '';
  const idOf = (subject: ApprovalSubject) => sanitizeSubjectText(subject.id) ?? '';
  const preview = (approval.preview ?? []).slice(0, 3);
  return (
    <div
      data-component="approval-entry"
      data-tool={approval.toolName}
      data-state={approval.state}
      data-decision={approval.decision}
      data-outcome={approval.outcome}
    >
      <StatusIcon icon={OUTCOME_ICONS[approval.outcome]} />
      <span data-element="description">{approval.label}</span>
      {lines.map((line, i) => (
        <span key={i} data-element="detail-line" data-subject="">
          <span data-element="detail-label">{line.label}</span>
          <span data-element="detail-value">{line.names.join(', ')}</span>
        </span>
      ))}
      {unchecked.length > 0 && (
        <span data-element="detail-line" data-check="unchecked">
          {unchecked.length === 1
            ? fillTemplate(locale.approvalSubjectUncheckedWarning, { label: labelOf(unchecked[0]!), id: idOf(unchecked[0]!) })
            : fillTemplate(locale.approvalSubjectsUncheckedWarning, {
              ids: unchecked.map((subject) => `${labelOf(subject)} ${idOf(subject)}`.trim()).join(', '),
            })}
        </span>
      )}
      {preview.map((item, i) => (
        <span key={`preview-${i}`} data-element="detail-line" data-preview="">
          <span data-element="detail-label">{sanitizeSubjectText(item.label) ?? item.key}</span>
          <span data-element="detail-value">{previewValueText(item, language)}</span>
        </span>
      ))}
      {approval.previewCheck === 'unchecked' && (
        <span data-element="detail-line" data-preview="unchecked">{locale.approvalPreviewUncheckedNote}</span>
      )}
      <span data-element="outcome">{approvalOutcomeText(approval.outcome, locale)}</span>
    </div>
  );
}
