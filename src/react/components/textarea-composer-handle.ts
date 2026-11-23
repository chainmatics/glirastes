import type { RefObject } from 'react';
import type { MentionData, RichMentionInputHandle } from '../types.js';

function mentionText(mention: MentionData): string {
  const prefix = mention.prefix || (mention.type === 'command' ? '/' : '@');
  return `${prefix}${mention.displayName ?? mention.label}`;
}

/**
 * Internal: a `RichMentionInputHandle` over the plain textarea, so
 * `useChatComposer` operations reach the plain chat input. The textarea has
 * no pills: mentions become their visible text (`@Label`, `/Command`) and
 * `getMentions` is always empty; there is no completion list.
 *
 * Every write goes to the textarea at once and to React through `setValue`,
 * so the next operation of the same batch reads the new text.
 */
export function createTextareaComposerHandle(
  ref: RefObject<HTMLTextAreaElement | null>,
  setValue: (text: string) => void,
): RichMentionInputHandle {
  const write = (text: string, caret = text.length) => {
    const element = ref.current;
    if (element) {
      element.value = text;
      element.setSelectionRange?.(caret, caret);
    }
    setValue(text);
  };
  const getValue = () => ref.current?.value ?? '';
  const insertAt = (text: string, atStart: boolean) => {
    const element = ref.current;
    const current = getValue();
    const focused = !!element && element.ownerDocument.activeElement === element;
    const at = atStart ? 0 : focused ? (element!.selectionStart ?? current.length) : current.length;
    const before = current.slice(0, at);
    const after = current.slice(at);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    // A separator only between words; at the end the next `insertText` adds its own.
    const tail = after && !/^\s/.test(after) ? ' ' : '';
    write(`${before}${lead}${text}${tail}${after}`, before.length + lead.length + text.length + tail.length);
  };
  return {
    focus: () => ref.current?.focus(),
    clear: () => write(''),
    getValue,
    setValue: (text) => write(text),
    getMentions: () => [],
    addMention: (mention) => insertAt(mentionText(mention), true),
    insertMention: (mention) => insertAt(mentionText(mention), false),
  };
}
