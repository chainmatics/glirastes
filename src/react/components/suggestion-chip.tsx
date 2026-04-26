import type { SuggestionChipProps } from '../types.js';

/**
 * Single suggestion chip button.
 *
 * Supports `disabled` and `isVisible` for fade animation.
 * The opacity transition is the only inline style — all other
 * styling is driven via data-* attributes.
 */
export function SuggestionChip({
  label,
  onClick,
  className,
  disabled,
  isVisible = true,
}: SuggestionChipProps) {
  return (
    <button
      className={className}
      onClick={onClick}
      disabled={disabled}
      data-component="suggestion-chip"
      data-visible={isVisible}
      style={{ opacity: isVisible ? 1 : 0, transition: 'opacity 300ms' }}
    >
      {label}
    </button>
  );
}
