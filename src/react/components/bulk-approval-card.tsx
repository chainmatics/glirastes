import { useId, useState } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { BulkApprovalCardProps } from '../types.js';
import { ApprovalIdWarning, approvalSubjectLines, flaggedApprovalSubjects } from './approval-card.js';

/**
 * Grouped approval card for 2+ tool calls of the same type.
 *
 * Shows one primary detail (first value) per approval for a compact overview.
 * Remaining approvals are hidden behind an expandable "+N more" toggle.
 * Uses `toolLabels` from context for human-readable tool action names.
 */
export function BulkApprovalCard({
  toolName,
  approvals,
  onApproveAll,
  onRejectAll,
  className,
  isProcessing,
}: BulkApprovalCardProps) {
  const { classNames, locale, toolLabels } = useChatContext();
  const [expanded, setExpanded] = useState(false);

  const count = approvals.length;
  const labels = toolLabels.labels?.[toolName] ?? { singular: toolName, plural: toolName };
  const actionLabel = count === 1 ? labels.singular : labels.plural;

  // Extract one primary detail per approval (first detail value = typically the title)
  const primaryDetails: string[] = [];
  for (const approval of approvals) {
    // The name of the call's id comes first, as on the single card.
    const subject = approvalSubjectLines(approval, locale)[0];
    if (subject) {
      primaryDetails.push(subject.names.join(', '));
    } else if (approval.details && approval.details.length > 0) {
      const first = approval.details[0];
      const colonIndex = first.indexOf(':');
      const value = colonIndex > -1 ? first.substring(colonIndex + 1).trim() : first;
      if (value) primaryDetails.push(value);
    }
  }
  const flagged = flaggedApprovalSubjects(approvals);
  const warningId = useId();

  const maxVisible = 3;
  const visibleDetails = expanded ? primaryDetails : primaryDetails.slice(0, maxVisible);
  const remainingCount = primaryDetails.length - maxVisible;
  const allCountText = (locale.allCountLabel ?? 'All {count}').replace('{count}', String(count));

  return (
    <div
      className={className ?? classNames.bulkApprovalCard}
      data-component="bulk-approval-card"
      data-tool={toolName}
      data-count={count}
      data-state={isProcessing ? 'processing' : 'pending'}
      data-warning={flagged.length > 0 ? '' : undefined}
    >
      {/* Header */}
      <div data-element="header">
        <span data-element="tool-icon" />
        <span data-element="description">
          {count} {actionLabel}?
        </span>
      </div>

      {/* One primary detail per approval */}
      {visibleDetails.length > 0 && (
        <div data-element="details">
          {visibleDetails.map((detail, i) => (
            <div key={i} data-element="detail-line">
              <span data-element="detail-bullet" />
              <span data-element="detail-value">{detail}</span>
            </div>
          ))}
          {remainingCount > 0 && !expanded && (
            <button
              type="button"
              data-element="detail-overflow"
              onClick={() => setExpanded(true)}
            >
              +{remainingCount} {locale.moreItemsLabel}
            </button>
          )}
        </div>
      )}

      {flagged.length > 0 && <ApprovalIdWarning id={warningId} subjects={flagged} />}

      {/* Actions */}
      <div data-element="actions">
        <button
          onClick={onRejectAll}
          disabled={isProcessing}
          data-action="reject"
        >
          {'\u2715'} {locale.cancelButton}
        </button>
        <button
          onClick={onApproveAll}
          disabled={isProcessing}
          data-action="approve"
          aria-describedby={flagged.length > 0 ? warningId : undefined}
        >
          {'\u2713'} {count === 1 ? (locale.confirmButton) : allCountText}
        </button>
      </div>
    </div>
  );
}
