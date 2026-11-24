/**
 * A keydown that belongs to an open IME composition (Japanese, Chinese,
 * Korean input): Enter commits the composed text, it must not send. Safari
 * fires the committing keydown after `compositionend`, flagged only by
 * keyCode 229.
 */
export function isImeKeyDown(event: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
  return event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
