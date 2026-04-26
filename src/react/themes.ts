import type {
  ChatTheme,
  ChatThemeColors,
  ChatThemeOverride,
  ChatThemePreset,
} from './types.js';

// ---------------------------------------------------------------------------
// Preset definitions
//
// Each preset is a closed `ResolvedTheme` — every CSS variable has a
// concrete value. Custom themes extend one of these (default:
// `professional-lightblue`) and override individual keys.
// ---------------------------------------------------------------------------

interface ResolvedTheme {
  colors: Required<ChatThemeColors>;
  radius: string;
  radiusSmall: string;
  fontFamily: string;
  /** Optional effect hint applied as `data-theme-effect` on widget roots. */
  effect?: 'glass';
}

const DEFAULT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const MONO_FONT =
  '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const PROFESSIONAL_LIGHTBLUE: ResolvedTheme = {
  colors: {
    primary: '#6366f1',
    primarySoft: '#818cf8',
    primaryTint: 'rgba(99, 102, 241, 0.12)',
    bg: '#ffffff',
    bgMuted: '#f9fafb',
    bubbleUser: '#e0e7ff',
    bubbleAssistant: '#f3f4f6',
    text: '#111827',
    textMuted: '#6b7280',
    border: '#e5e7eb',
    danger: '#dc2626',
  },
  radius: '0.875rem',
  radiusSmall: '0.5rem',
  fontFamily: DEFAULT_FONT,
};

const PROFESSIONAL_DARK: ResolvedTheme = {
  colors: {
    primary: '#818cf8',
    primarySoft: '#a78bfa',
    primaryTint: 'rgba(129, 140, 248, 0.18)',
    bg: '#0f172a',
    bgMuted: '#1e293b',
    bubbleUser: '#312e81',
    bubbleAssistant: '#1e293b',
    text: '#f8fafc',
    textMuted: '#94a3b8',
    border: '#334155',
    danger: '#f87171',
  },
  radius: '0.875rem',
  radiusSmall: '0.5rem',
  fontFamily: DEFAULT_FONT,
};

const MINIMAL_WHITE: ResolvedTheme = {
  colors: {
    primary: '#111827',
    primarySoft: '#374151',
    primaryTint: 'rgba(17, 24, 39, 0.06)',
    bg: '#ffffff',
    bgMuted: '#fafafa',
    bubbleUser: '#f3f4f6',
    bubbleAssistant: '#fafafa',
    text: '#111827',
    textMuted: '#6b7280',
    border: '#e5e7eb',
    danger: '#991b1b',
  },
  radius: '0.5rem',
  radiusSmall: '0.375rem',
  fontFamily: DEFAULT_FONT,
};

const VIBRANT_INDIGO: ResolvedTheme = {
  colors: {
    primary: '#8b5cf6',
    primarySoft: '#ec4899',
    primaryTint: 'rgba(139, 92, 246, 0.16)',
    bg: '#ffffff',
    bgMuted: '#faf5ff',
    bubbleUser: '#ede9fe',
    bubbleAssistant: '#fdf2f8',
    text: '#1e1b4b',
    textMuted: '#6b21a8',
    border: '#e9d5ff',
    danger: '#dc2626',
  },
  radius: '1.25rem',
  radiusSmall: '0.75rem',
  fontFamily: DEFAULT_FONT,
};

const TERMINAL_GREEN: ResolvedTheme = {
  colors: {
    primary: '#22c55e',
    primarySoft: '#4ade80',
    primaryTint: 'rgba(34, 197, 94, 0.15)',
    bg: '#000000',
    bgMuted: '#0a0a0a',
    bubbleUser: '#052e16',
    bubbleAssistant: '#0a0a0a',
    text: '#4ade80',
    textMuted: '#15803d',
    border: '#14532d',
    danger: '#ef4444',
  },
  radius: '0.25rem',
  radiusSmall: '0.125rem',
  fontFamily: MONO_FONT,
};

/** Translucent frosted-glass look — pairs with a blurred background. */
const LIQUID_GLASS: ResolvedTheme = {
  colors: {
    primary: '#60a5fa',
    primarySoft: '#c4b5fd',
    primaryTint: 'rgba(96, 165, 250, 0.18)',
    bg: 'rgba(255, 255, 255, 0.72)',
    bgMuted: 'rgba(255, 255, 255, 0.55)',
    bubbleUser: 'rgba(96, 165, 250, 0.22)',
    bubbleAssistant: 'rgba(255, 255, 255, 0.82)',
    text: '#0f172a',
    textMuted: '#475569',
    border: 'rgba(255, 255, 255, 0.6)',
    danger: '#ef4444',
  },
  radius: '1.5rem',
  radiusSmall: '0.875rem',
  fontFamily: DEFAULT_FONT,
  effect: 'glass',
};

const PURPLE_HAZE: ResolvedTheme = {
  colors: {
    primary: '#a855f7',
    primarySoft: '#d946ef',
    primaryTint: 'rgba(168, 85, 247, 0.18)',
    bg: '#1a0b2e',
    bgMuted: '#2a1348',
    bubbleUser: '#4c1d95',
    bubbleAssistant: '#2a1348',
    text: '#f5f3ff',
    textMuted: '#c4b5fd',
    border: '#4c1d95',
    danger: '#fb7185',
  },
  radius: '1rem',
  radiusSmall: '0.625rem',
  fontFamily: DEFAULT_FONT,
};

const BLUE_DREAM: ResolvedTheme = {
  colors: {
    primary: '#3b82f6',
    primarySoft: '#0ea5e9',
    primaryTint: 'rgba(59, 130, 246, 0.14)',
    bg: '#f0f9ff',
    bgMuted: '#e0f2fe',
    bubbleUser: '#dbeafe',
    bubbleAssistant: '#ffffff',
    text: '#0c4a6e',
    textMuted: '#0369a1',
    border: '#bae6fd',
    danger: '#dc2626',
  },
  radius: '1.125rem',
  radiusSmall: '0.625rem',
  fontFamily: DEFAULT_FONT,
};

const SUNSET_ORANGE: ResolvedTheme = {
  colors: {
    primary: '#f97316',
    primarySoft: '#ec4899',
    primaryTint: 'rgba(249, 115, 22, 0.16)',
    bg: '#fffbeb',
    bgMuted: '#fef3c7',
    bubbleUser: '#fed7aa',
    bubbleAssistant: '#ffffff',
    text: '#7c2d12',
    textMuted: '#b45309',
    border: '#fde68a',
    danger: '#dc2626',
  },
  radius: '1.25rem',
  radiusSmall: '0.75rem',
  fontFamily: DEFAULT_FONT,
};

const OCEAN_TEAL: ResolvedTheme = {
  colors: {
    primary: '#14b8a6',
    primarySoft: '#06b6d4',
    primaryTint: 'rgba(20, 184, 166, 0.14)',
    bg: '#042f2e',
    bgMuted: '#134e4a',
    bubbleUser: '#115e59',
    bubbleAssistant: '#134e4a',
    text: '#ccfbf1',
    textMuted: '#5eead4',
    border: '#134e4a',
    danger: '#fb7185',
  },
  radius: '0.875rem',
  radiusSmall: '0.5rem',
  fontFamily: DEFAULT_FONT,
};

/** Pure monochrome. Black background, stark white text, zero color. */
const MIDNIGHT_MONO: ResolvedTheme = {
  colors: {
    primary: '#ffffff',
    primarySoft: '#d4d4d4',
    primaryTint: 'rgba(255, 255, 255, 0.08)',
    bg: '#0a0a0a',
    bgMuted: '#171717',
    bubbleUser: '#262626',
    bubbleAssistant: '#171717',
    text: '#fafafa',
    textMuted: '#a3a3a3',
    border: '#262626',
    danger: '#f87171',
  },
  radius: '0.75rem',
  radiusSmall: '0.375rem',
  fontFamily: DEFAULT_FONT,
};

const PRESETS: Record<ChatThemePreset, ResolvedTheme> = {
  'professional-lightblue': PROFESSIONAL_LIGHTBLUE,
  'professional-dark': PROFESSIONAL_DARK,
  'minimal-white': MINIMAL_WHITE,
  'vibrant-indigo': VIBRANT_INDIGO,
  'terminal-green': TERMINAL_GREEN,
  'liquid-glass': LIQUID_GLASS,
  'purple-haze': PURPLE_HAZE,
  'blue-dream': BLUE_DREAM,
  'sunset-orange': SUNSET_ORANGE,
  'ocean-teal': OCEAN_TEAL,
  'midnight-mono': MIDNIGHT_MONO,
};

export const DEFAULT_THEME_PRESET: ChatThemePreset = 'professional-lightblue';

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolve(theme?: ChatTheme): ResolvedTheme {
  if (!theme) return PROFESSIONAL_LIGHTBLUE;
  if (typeof theme === 'string') return PRESETS[theme] ?? PROFESSIONAL_LIGHTBLUE;

  const override: ChatThemeOverride = theme;
  const base =
    (override.preset && PRESETS[override.preset]) ?? PROFESSIONAL_LIGHTBLUE;
  return {
    colors: { ...base.colors, ...(override.colors ?? {}) },
    radius: override.radius ?? base.radius,
    radiusSmall: override.radiusSmall ?? base.radiusSmall,
    fontFamily: override.fontFamily ?? base.fontFamily,
    effect: base.effect,
  };
}

/** Returns the `data-theme-effect` attribute value for a theme, or `undefined`. */
export function getThemeEffect(theme?: ChatTheme): string | undefined {
  return resolve(theme).effect;
}

/**
 * Resolve a `ChatTheme` prop into a plain `Record<string, string>` of
 * CSS custom properties that can be spread onto a component `style` prop.
 *
 * ```tsx
 * const vars = getThemeVars(theme);
 * <div style={vars}>…</div>
 * ```
 */
export function getThemeVars(theme?: ChatTheme): Record<string, string> {
  const r = resolve(theme);
  return {
    '--cm-primary': r.colors.primary,
    '--cm-primary-soft': r.colors.primarySoft,
    '--cm-primary-tint': r.colors.primaryTint,
    '--cm-bg': r.colors.bg,
    '--cm-bg-muted': r.colors.bgMuted,
    '--cm-bubble-user': r.colors.bubbleUser,
    '--cm-bubble-assistant': r.colors.bubbleAssistant,
    '--cm-text': r.colors.text,
    '--cm-text-muted': r.colors.textMuted,
    '--cm-border': r.colors.border,
    '--cm-danger': r.colors.danger,
    '--cm-radius': r.radius,
    '--cm-radius-sm': r.radiusSmall,
    '--cm-font': r.fontFamily,
  };
}

export { PRESETS as CHAT_THEME_PRESETS };
