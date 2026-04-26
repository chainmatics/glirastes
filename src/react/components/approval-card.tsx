import { useChatContext } from '../provider/chat-context.js';
import type { ApprovalCardProps } from '../types.js';

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
  const { classNames, locale } = useChatContext();

  return (
    <div
      className={className ?? classNames.approvalCard}
      data-component="approval-card"
      data-tool={approval.toolName}
      data-state={isProcessing ? 'processing' : 'pending'}
    >
      {/* Header */}
      <div data-element="header">
        <span data-element="description">
          {approval.description ?? approval.toolName}
        </span>
      </div>

      {/* Details */}
      {approval.details && approval.details.length > 0 && (
        <div data-element="details">
          {approval.details.map((detail, i) => {
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
                <span data-element="detail-value">{value}</span>
              </div>
            );
          })}
        </div>
      )}

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
        >
          {'\u2713'} {approval.confirmText ?? locale.confirmButton}
        </button>
      </div>
    </div>
  );
}
