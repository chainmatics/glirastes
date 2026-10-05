import { CHAT_THEME_PRESETS, getThemeVars } from '../react/themes.js';
import type { ChatThemePreset } from '../react/types.js';

/** Public CSS custom properties a host page may set on `<glirastes-chat>`. */
export const EMBED_CSS_VARIABLES = Object.freeze([
  '--glirastes-chat-primary',
  '--glirastes-chat-primary-soft',
  '--glirastes-chat-primary-tint',
  '--glirastes-chat-bg',
  '--glirastes-chat-bg-muted',
  '--glirastes-chat-bubble-user',
  '--glirastes-chat-bubble-assistant',
  '--glirastes-chat-text',
  '--glirastes-chat-text-muted',
  '--glirastes-chat-border',
  '--glirastes-chat-danger',
  '--glirastes-chat-radius',
  '--glirastes-chat-radius-sm',
  '--glirastes-chat-font',
] as const);

export function isChatThemePreset(value: string | null | undefined): value is ChatThemePreset {
  return typeof value === 'string' && Object.hasOwn(CHAT_THEME_PRESETS, value);
}

/**
 * Shadow-root theme rules. Host CSS variables (`--glirastes-chat-*`) win;
 * the selected preset supplies the fallback. Inline panel variables are
 * disabled in the embed (`themeScope: 'inherit'`) so these rules apply.
 */
export function embedThemeCss(preset?: ChatThemePreset): string {
  const declarations = Object.entries(getThemeVars(preset))
    .map(([name, value]) => {
      const publicName = name.replace(/^--cm-/, '--glirastes-chat-');
      return `  ${name}: var(${publicName}, ${value});`;
    })
    .join('\n');
  return [
    ':host { display: block; position: relative; height: 100%; min-height: 0; }',
    ':host([hidden]) { display: none; }',
    '[data-part="mount"] { height: 100%; }',
    `[data-component="ai-chat-panel"] {\n${declarations}\n}`,
  ].join('\n');
}
