/**
 * Appended to the first compound of every rule in `styles.css`. It matches
 * nothing at or inside a root that carries `data-unstyled`, so `unstyled`
 * on `AiChatProvider` turns all shipped styles off without changing their
 * specificity anywhere else.
 */
export const UNSTYLED_GUARD = ':where(:not([data-unstyled], [data-unstyled] *))';
