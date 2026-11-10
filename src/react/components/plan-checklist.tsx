import { useChatContext } from '../provider/chat-context.js';
import type { PlanItem } from '../../contracts/plan.js';
import { StatusIcon } from './status-icon.js';

export interface PlanChecklistProps {
  items: ReadonlyArray<PlanItem>;
  /** True while this message's turn still runs; only then does an item spin. */
  active: boolean;
  className?: string;
}

/**
 * Task list the model records with the built-in `update_plan` tool for a
 * request with several distinct actions. Renders nothing below two items.
 *
 * Keeps styling neutral via `data-*` attributes.
 */
export function PlanChecklist({ items, active, className }: PlanChecklistProps) {
  const { locale } = useChatContext();
  if (items.length < 2) return null;

  return (
    <section className={className} data-component="plan-checklist">
      <strong data-element="title">{locale.planTitle}</strong>
      <ol data-element="plan-items">
        {items.map((item, index) => (
          <li key={`${index}-${item.title}`} data-element="plan-item" data-status={item.status}>
            <StatusIcon
              icon={item.status === 'completed'
                ? 'check'
                : item.status === 'in_progress' && active ? 'spinner' : 'pending'}
            />
            <span data-element="label">{item.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
