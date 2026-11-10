import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface SidebarResizeOptions {
  active: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  storageKey?: string;
  onWidthChange?: (width: number) => void;
}

function restoreWidth(key: string | undefined, fallback: number) {
  try {
    const stored = key && typeof window !== 'undefined' ? window.sessionStorage.getItem(key) : null;
    const value = stored === null ? fallback : Number(stored);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Independent right-sidebar geometry; never mutates floating position/size. */
export function useSidebarResize({ active, width: initialWidth, minWidth, maxWidth, storageKey, onWidthChange }: SidebarResizeOptions) {
  const minimum = Number.isFinite(minWidth) ? Math.max(44, minWidth) : 320;
  const maximum = Number.isFinite(maxWidth) ? Math.max(minimum, maxWidth) : Math.max(minimum, 800);
  const fallback = Number.isFinite(initialWidth) ? initialWidth : 420;
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  const [state, setState] = useState(() => ({ key: storageKey, initial: fallback, value: restoreWidth(storageKey, fallback) }));
  let value = state.value;
  if (state.key !== storageKey || state.initial !== fallback) {
    value = state.key !== storageKey ? restoreWidth(storageKey, fallback) : fallback;
    setState({ key: storageKey, initial: fallback, value });
  }
  const width = clamp(value);
  const cleanupRef = useRef<(() => void) | null>(null);
  const requestedWidthRef = useRef<number | undefined>(undefined);
  const release = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  // A changed configuration must terminate the old pointer closure, including
  // its captured bounds, width, and storage scope.
  useEffect(() => release, [active, minimum, maximum, storageKey, release]);
  useEffect(() => {
    // Parent state may echo every onWidthChange during a gesture. Only an
    // independent width change should interrupt it, not our own last update.
    if (fallback !== requestedWidthRef.current) release();
  }, [fallback, release]);
  useEffect(() => {
    if (!storageKey) return;
    try { window.sessionStorage.setItem(storageKey, String(width)); } catch { /* Optional browser persistence. */ }
  }, [storageKey, width]);

  const resize = (next: number) => {
    const bounded = clamp(next);
    requestedWidthRef.current = bounded;
    setState({ key: storageKey, initial: fallback, value: bounded });
    onWidthChange?.(bounded);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!active || event.button !== 0) return;
    release();
    const startX = event.clientX;
    const startWidth = width;
    const pointerId = event.pointerId;
    const previousSelection = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      resize(startWidth + startX - next.clientX);
      next.preventDefault();
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) release();
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    window.addEventListener('blur', release);
    cleanupRef.current = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', release);
      document.body.style.userSelect = previousSelection;
    };
    event.currentTarget.focus();
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 50 : 20;
    const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: minimum, End: maximum }[event.key];
    if (next === undefined) return;
    release();
    resize(next);
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    width, minimum, maximum, onPointerDown, onKeyDown,
    onDoubleClick: () => { if (active) { release(); resize(fallback); } },
  };
}
