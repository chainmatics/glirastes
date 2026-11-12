import { useState } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { ApprovalCardProps } from '../types.js';

const COLLAPSED_ITEMS = 2;
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
                <DetailValue value={value} items={approval.detailItems?.[i]} />
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
