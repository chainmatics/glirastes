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

  // Lines every approval states alike (a scope, a team) are shown once under the header;
  // each item then shows its first line that differs, so six notes are not six "scope" lines.
  const sharedLines = count > 1 ? sharedDetailLines(approvals.map((approval) => approval.details ?? [])) : [];
  const primaryDetails: string[] = [];
  for (const approval of approvals) {
    // The name of the call's id comes first, as on the single card.
    const subject = approvalSubjectLines(approval, locale)[0];
    if (subject) {
      primaryDetails.push(subject.names.join(', '));
      continue;
    }
    const details = approval.details ?? [];
    const line = details.find((detail) => !sharedLines.includes(detail)) ?? details[0];
    const value = line === undefined ? '' : detailValue(line);
    if (value) primaryDetails.push(value);
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

      {sharedLines.length > 0 && (
        <div data-element="shared-details">
          {sharedLines.map((line) => (
            <div key={line} data-element="shared-detail">{line}</div>
          ))}
        </div>
      )}

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

function detailValue(line: string): string {
  const colonIndex = line.indexOf(':');
  return (colonIndex > -1 ? line.substring(colonIndex + 1) : line).trim();
}

/** Detail lines that every approval states, in the order of the first. */
function sharedDetailLines(detailsPerApproval: ReadonlyArray<readonly string[]>): string[] {
  const [first, ...rest] = detailsPerApproval;
  if (!first) return [];
  const shared = first.filter((line) => rest.every((details) => details.includes(line)));
  // When nothing tells the items apart, keep showing their first line instead.
  return shared.length === first.length ? [] : shared;
}
