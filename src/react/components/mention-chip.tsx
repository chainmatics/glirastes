import type { MentionChipProps, MentionChipListProps } from '../types.js';

/**
 * Inline mention chip for displaying referenced entities.
 *
 * Renders with data-attributes for styling by the host app:
 * - `data-component="mention-chip"`
 * - `data-mention-type` — the mention type (task, person, group, command, etc.)
 * - `data-size` — "inline" | "compact" | "default"
 *
 * Sub-elements: icon, prefix, display-name, remove button.
 */
export function MentionChip({
  mention,
  onRemove,
  className,
  compact = false,
  inline = false,
}: MentionChipProps) {
  const size = inline ? 'inline' : compact ? 'compact' : 'default';
  const prefix = mention.prefix ?? (mention.type === 'task' || mention.type === 'command' ? '/' : '@');

  return (
    <span
      className={className}
      data-component="mention-chip"
      data-mention-type={mention.type}
      data-size={size}
    >
      <span data-element="icon" />
      <span data-element="display-name">
        <span data-element="prefix">{prefix}</span>
        {mention.displayName}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          data-action="remove"
        >
          {'\u00D7'}
          <span style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0,0,0,0)',
            whiteSpace: 'nowrap',
            borderWidth: 0,
          }}>
            Remove
          </span>
        </button>
      )}
    </span>
  );
}

/**
 * List of mention chips wrapped in a container.
 */
export function MentionChipList({
  mentions,
  onRemove,
  className,
}: MentionChipListProps) {
  if (mentions.length === 0) return null;

  return (
    <div className={className} data-component="mention-chip-list">
      {mentions.map((mention) => (
        <MentionChip
          key={mention.id}
          mention={mention}
          onRemove={onRemove ? () => onRemove(mention.id) : undefined}
        />
      ))}
    </div>
  );
}
