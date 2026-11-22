import { useChatContext } from '../provider/chat-context.js';

export interface ComposerHintProps {
  /** A completion list is open: the list keys instead of send / new line (`composer.completionOpen`). */
  completionOpen?: boolean;
  className?: string;
}

/**
 * The keyboard hint under the composer (`composer.hint`): "↵ Send · ⇧ ↵ New
 * line", and the list keys while a completion list is open. Texts come from
 * the chat locale. `aria-hidden`: the keys are the textbox's standard ones and
 * an open list announces itself, so screen readers get no duplicate glyphs.
 * Render it in an own composer with `completionOpen={composer.completionOpen}`.
 */
export function ComposerHint({ completionOpen = false, className }: ComposerHintProps) {
  const { locale } = useChatContext();
  return (
    <div data-component="composer-hint" aria-hidden="true" className={className}>
      {completionOpen ? (
        <span data-hint="completion">
          <kbd>↑ ↓</kbd> {locale.composerHintNavigate ?? 'Navigate'} · <kbd>↵</kbd> {locale.composerHintPick ?? 'Pick suggestion'} · <kbd>Esc</kbd> {locale.composerHintClose ?? 'Close'}
        </span>
      ) : (
        <span data-hint="compose">
          <kbd>↵</kbd> {locale.composerHintSend ?? 'Send'} · <kbd>⇧ ↵</kbd> {locale.composerHintNewline ?? 'New line'}
        </span>
      )}
    </div>
  );
}
