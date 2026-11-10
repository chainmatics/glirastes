import { useId, useState, type FormEvent } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { isClarificationAnswered } from '../utils/clarification.js';
import type { ClarificationCardProps } from '../types.js';

/**
 * Structured clarification: concrete options plus an optional free-text
 * answer. Answering sends one user message that resumes the original task.
 *
 * `data-state`: `open` while answerable, `answered` once an answer exists
 * (clicked here or already in the conversation), `disabled` while it cannot
 * be answered yet (the turn is still running or a newer message exists).
 */
export function ClarificationCard({
  toolCallId,
  request,
  interactive,
  onAnswer,
  className,
}: ClarificationCardProps) {
  const { classNames, locale, messages } = useChatContext();
  const questionId = useId();
  const [draft, setDraft] = useState('');
  const [answeredHere, setAnsweredHere] = useState(false);
  const answered = answeredHere || isClarificationAnswered(messages, toolCallId);
  const enabled = interactive && !answered;

  const answer = (text: string, optionId?: string) => {
    const trimmed = text.trim();
    if (!enabled || !trimmed) return;
    setAnsweredHere(true);
    onAnswer(optionId === undefined ? { text: trimmed } : { text: trimmed, optionId });
  };

  const submitFreeText = (event: FormEvent) => {
    event.preventDefault();
    answer(draft);
  };

  return (
    <div
      className={className ?? classNames.clarificationCard}
      data-component="clarification-card"
      data-state={enabled ? 'open' : answered ? 'answered' : 'disabled'}
      data-tool-call-id={toolCallId}
      role="group"
      aria-labelledby={questionId}
    >
      <p id={questionId} data-element="question">{request.question}</p>
      {request.options.length > 0 && (
        <div data-element="options">
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              data-action="answer-option"
              data-option-id={option.id}
              disabled={!enabled}
              onClick={() => answer(option.label, option.id)}
            >
              <span data-element="label">{option.label}</span>
              {option.description && (
                <span data-element="description">{option.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {request.allowFreeText && enabled && (
        <form data-element="free-text" onSubmit={submitFreeText}>
          <input
            type="text"
            value={draft}
            maxLength={500}
            aria-label={locale.clarificationInputLabel}
            placeholder={locale.clarificationInputLabel}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" data-action="answer-free-text" disabled={!draft.trim()}>
            {locale.clarificationSubmitButton}
          </button>
        </form>
      )}
    </div>
  );
}
