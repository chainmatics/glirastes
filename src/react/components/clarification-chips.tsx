import { useChatContext } from '../provider/chat-context.js';
import { composerContextOf } from '../provider/composer-context.js';
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';

export interface ClarificationChipsProps {
  className?: string;
}

/**
 * The options of the open clarification as chips above the composer
 * (`composer.clarificationChips`). A chip sends the same answer message as
 * the card's option button. Nothing while a turn runs, once the
 * clarification is answered (also by a typed message) or when it has no
 * options; disabled while the composer is locked. `AiChatPanel` renders it;
 * use it in an own panel above the composer.
 */
export function ClarificationChips({ className }: ClarificationChipsProps) {
  const context = useChatContext();
  const { messages, isLoading, canCompose: composable, send, locale } = context;
  if (!composerContextOf(context).composer?.clarificationChips || isLoading) return null;
  // The latest message is the assistant's: any later user message (an answer) closes it.
  const open = findOpenClarification(messages);
  if (!open || open.request.options.length === 0) return null;
  const locked = !(composable ?? !isLoading);

  return (
    <div
      className={className}
      data-component="clarification-chips"
      role="group"
      aria-label={locale.clarificationChipsLabel ?? 'Answer options'}
    >
      {open.request.options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-element="option"
          data-option-id={option.id}
          disabled={locked}
          {...(option.description ? { title: option.description } : {})}
          onClick={() => {
            if (locked) return;
            send(clarificationAnswerMessage({ toolCallId: open.toolCallId, answer: option.label, optionId: option.id }));
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
