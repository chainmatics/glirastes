'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** Docked on the right of the page, or a detached window above it. */
export type AssistantLayoutMode = 'sidebar' | 'floating';

export interface AssistantLayoutState {
  open: boolean;
  mode: AssistantLayoutMode;
  /**
   * The layout the assistant opens in. Detaching or docking the open
   * assistant updates it, so a closed window comes back as a window.
   */
  defaultMode: AssistantLayoutMode;
  /** Sidebar folded to a narrow rail. */
  collapsed: boolean;
  /** Sidebar width in pixels. */
  width: number;
}

export interface AssistantLayoutLimits {
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  defaultMode: AssistantLayoutMode;
}

export const DEFAULT_ASSISTANT_LAYOUT_KEY = 'glirastes:assistant-layout:v1';
export const DEFAULT_ASSISTANT_LAYOUT_LIMITS: AssistantLayoutLimits = Object.freeze({
  minWidth: 400,
  maxWidth: 800,
  defaultWidth: 420,
  defaultMode: 'sidebar' as const,
});

function limitsOf(limits?: Partial<AssistantLayoutLimits>): AssistantLayoutLimits {
  return { ...DEFAULT_ASSISTANT_LAYOUT_LIMITS, ...limits };
}

export function clampAssistantWidth(width: number, limits?: Partial<AssistantLayoutLimits>): number {
  const { minWidth, maxWidth, defaultWidth } = limitsOf(limits);
  return Math.max(minWidth, Math.min(maxWidth, Number.isFinite(width) ? width : defaultWidth));
}

export function defaultAssistantLayout(limits?: Partial<AssistantLayoutLimits>): AssistantLayoutState {
  const { defaultMode, defaultWidth } = limitsOf(limits);
  return { open: false, mode: defaultMode, defaultMode, collapsed: false, width: clampAssistantWidth(defaultWidth, limits) };
}

/** Reads a stored layout; anything invalid falls back to the defaults. */
export function parseAssistantLayout(raw: string | null, limits?: Partial<AssistantLayoutLimits>): AssistantLayoutState {
  const fallback = defaultAssistantLayout(limits);
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const mode = value.mode === 'floating' || value.mode === 'sidebar' ? value.mode : fallback.mode;
    const defaultMode = value.defaultMode === 'floating' || value.defaultMode === 'sidebar'
      ? value.defaultMode
      : value.mode === 'floating' || value.mode === 'sidebar' ? value.mode : fallback.defaultMode;
    return {
      open: typeof value.open === 'boolean' ? value.open : false,
      mode,
      defaultMode,
      collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : false,
      width: typeof value.width === 'number' ? clampAssistantWidth(value.width, limits) : fallback.width,
    };
  } catch {
    return fallback;
  }
}

export interface AssistantLayout extends AssistantLayoutState {
  limits: AssistantLayoutLimits;
  openChat(): void;
  closeChat(): void;
  toggleChat(): void;
  /** Switches the layout and remembers it for the next opening. */
  setMode(mode: AssistantLayoutMode): void;
  /** Sets the layout the next opening uses, without moving an open assistant. */
  setDefaultMode(mode: AssistantLayoutMode): void;
  setCollapsed(value: boolean): void;
  toggleCollapsed(): void;
  setWidth(width: number): void;
}

export interface AssistantLayoutProviderProps extends Partial<AssistantLayoutLimits> {
  children: ReactNode;
  /** localStorage key; `null` keeps the layout in memory only. Scope it per user when several share a browser. */
  storageKey?: string | null;
}

const AssistantLayoutContext = createContext<AssistantLayout | null>(null);

/**
 * Open state, layout and sidebar width of the assistant, persisted per
 * browser. Storage is read after hydration, so server and client render
 * the same closed assistant first.
 */
export function AssistantLayoutProvider({
  children,
  storageKey = DEFAULT_ASSISTANT_LAYOUT_KEY,
  minWidth,
  maxWidth,
  defaultWidth,
  defaultMode,
}: AssistantLayoutProviderProps) {
  const limits = useMemo(
    () => limitsOf(Object.fromEntries(Object.entries({ minWidth, maxWidth, defaultWidth, defaultMode }).filter(([, v]) => v !== undefined))),
    [minWidth, maxWidth, defaultWidth, defaultMode],
  );
  const [state, setState] = useState<AssistantLayoutState>(() => defaultAssistantLayout(limits));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!storageKey) { setReady(true); return; }
    const frame = requestAnimationFrame(() => {
      try { setState(parseAssistantLayout(localStorage.getItem(storageKey), limits)); } catch { /* Storage disabled */ }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [storageKey, limits]);
  useEffect(() => {
    if (ready && storageKey) try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage full */ }
  }, [ready, state, storageKey]);

  const openChat = useCallback(() => setState(s => ({ ...s, open: true, mode: s.open ? s.mode : s.defaultMode, collapsed: false })), []);
  const closeChat = useCallback(() => setState(s => ({ ...s, open: false })), []);
  const toggleChat = useCallback(() => setState(s => s.open && s.collapsed && s.mode === 'sidebar'
    ? { ...s, collapsed: false }
    : { ...s, open: !s.open, mode: s.open ? s.mode : s.defaultMode, collapsed: false }), []);
  const setMode = useCallback((mode: AssistantLayoutMode) => setState(s => ({ ...s, mode, defaultMode: mode })), []);
  const setDefaultMode = useCallback((mode: AssistantLayoutMode) => setState(s => ({ ...s, defaultMode: mode, mode: s.open ? s.mode : mode })), []);
  const setCollapsed = useCallback((collapsed: boolean) => setState(s => ({ ...s, collapsed })), []);
  const toggleCollapsed = useCallback(() => setState(s => ({ ...s, collapsed: !s.collapsed })), []);
  const setWidth = useCallback((width: number) => setState(s => ({ ...s, width: clampAssistantWidth(width, limits) })), [limits]);

  const value = useMemo<AssistantLayout>(
    () => ({ ...state, limits, openChat, closeChat, toggleChat, setMode, setDefaultMode, setCollapsed, toggleCollapsed, setWidth }),
    [state, limits, openChat, closeChat, toggleChat, setMode, setDefaultMode, setCollapsed, toggleCollapsed, setWidth],
  );
  return <AssistantLayoutContext.Provider value={value}>{children}</AssistantLayoutContext.Provider>;
}

export function useAssistantLayout(): AssistantLayout {
  const value = useContext(AssistantLayoutContext);
  if (!value) throw new Error('useAssistantLayout must be used inside <AssistantLayoutProvider>');
  return value;
}

/** The surrounding layout, or null outside an `AssistantLayoutProvider`. */
export function useOptionalAssistantLayout(): AssistantLayout | null {
  return useContext(AssistantLayoutContext);
}
