import { useChatContext } from '../provider/chat-context.js';
import type { ApprovalEntryProps, ApprovalOutcome, ChatLocale } from '../types.js';
import { approvalSubjectLines } from './approval-card.js';
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
  const { locale } = useChatContext();
  const lines = approvalSubjectLines(
    { id: approval.approvalId, toolName: approval.toolName, args: {}, messageId: '', ...(approval.details ? { details: approval.details } : {}), ...(approval.subjects ? { subjects: approval.subjects } : {}) },
    locale,
  );
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
      <span data-element="outcome">{approvalOutcomeText(approval.outcome, locale)}</span>
    </div>
  );
}
