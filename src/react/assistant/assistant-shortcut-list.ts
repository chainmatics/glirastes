import {
  formatShortcut,
  resolveChatShortcuts,
  type ChatShortcutAction,
  type ChatShortcutMap,
} from '../hooks/use-chat-shortcuts.js';
import { isGerman } from '../utils/tool-presentation.js';

export type AssistantShortcutLabels = Record<ChatShortcutAction, string>;

export const DEFAULT_ASSISTANT_SHORTCUT_LABELS: AssistantShortcutLabels = Object.freeze({
  toggle: 'Open or close the assistant',
  toggleLayout: 'Dock or detach',
  toggleCollapse: 'Collapse or expand',
  newChat: 'New chat',
  focusInput: 'Focus the input',
  close: 'Close the assistant',
});

export const DE_ASSISTANT_SHORTCUT_LABELS: AssistantShortcutLabels = Object.freeze({
  toggle: 'Assistent öffnen oder schließen',
  toggleLayout: 'Andocken oder ablösen',
  toggleCollapse: 'Ein- oder ausklappen',
  newChat: 'Neuer Chat',
  focusInput: 'Eingabefeld fokussieren',
  close: 'Assistent schließen',
});

const ORDER: readonly ChatShortcutAction[] = ['toggle', 'toggleLayout', 'toggleCollapse', 'newChat', 'focusInput', 'close'];

export interface AssistantShortcutEntry {
  action: ChatShortcutAction;
  /** The combination as configured, such as `mod+i`. */
  combo: string;
  /** The combination for display: `⌘I` on Apple platforms, `Ctrl+I` elsewhere. */
  keys: string;
  label: string;
}

export interface AssistantShortcutListOptions {
  /** The same overrides the app passes to the assistant. */
  shortcuts?: ChatShortcutMap;
  /** Page language; German pages get the German labels. */
  language?: string | null;
  labels?: Partial<AssistantShortcutLabels>;
}

/**
 * The assistant's active shortcuts with their labels, in a fixed order, for
 * an app's shortcut overview or help dialog. Switched-off actions are left out.
 */
export function assistantShortcutList(options: AssistantShortcutListOptions = {}): AssistantShortcutEntry[] {
  const combos = resolveChatShortcuts(options.shortcuts);
  const labels = { ...(isGerman(options.language) ? DE_ASSISTANT_SHORTCUT_LABELS : DEFAULT_ASSISTANT_SHORTCUT_LABELS), ...options.labels };
  return ORDER.flatMap((action) => {
    const combo = combos[action];
    return combo ? [{ action, combo, keys: formatShortcut(combo), label: labels[action] }] : [];
  });
}
