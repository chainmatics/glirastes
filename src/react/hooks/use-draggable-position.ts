import { useState, useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDraggablePositionOptions {
  /** Enable dragging. Default: true */
  enabled?: boolean;
  /** Movement threshold in px before a mousedown is treated as a drag. Default: 5 */
  dragThreshold?: number;
  /** SessionStorage key prefix for persisting position. Falsy = no persistence. */
  persistKey?: string | false;
}

export interface UseDraggablePositionReturn {
  /** Current position, or null if at default (not yet dragged / reset). */
  position: { x: number; y: number } | null;
  /** Whether the user is currently dragging. */
  isDragging: boolean;
  /** Attach to onMouseDown on the draggable element. */
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  /** Whether the last interaction was a drag (true) vs a click (false).
   *  Reset to false on the next mousedown. Use to suppress onClick. */
  wasDragged: boolean;
  /** Programmatically reset to default position. */
  resetPosition: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPosition(key: string): { x: number; y: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writePosition(key: string, pos: { x: number; y: number } | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (pos) {
      sessionStorage.setItem(key, JSON.stringify(pos));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore quota / private-browsing errors
  }
}

function clampToViewport(x: number, y: number, elWidth: number, elHeight: number) {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - elWidth - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - elHeight - margin)),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDraggablePosition(
  options: UseDraggablePositionOptions = {},
): UseDraggablePositionReturn {
  const { enabled = true, dragThreshold = 5, persistKey = false } = options;

  const storageKey = persistKey ? `draggable-pos-${persistKey}` : null;

  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => (storageKey ? readPosition(storageKey) : null),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [wasDragged, setWasDragged] = useState(false);

  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startElX: number;
    startElY: number;
    el: HTMLElement;
    didMove: boolean;
  } | null>(null);

  // Persist position changes
  useEffect(() => {
    if (storageKey) {
      writePosition(storageKey, position);
    }
  }, [storageKey, position]);

  // ------ mousedown handler ------
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!enabled) return;
      if (e.button !== 0) return;
      // Don't intercept clicks on nested interactive children (but allow
      // when the matched element is the container itself, i.e. currentTarget)
      const interactiveEl = (e.target as HTMLElement).closest('button, a, input, [role="button"]');
      if (interactiveEl && interactiveEl !== e.currentTarget) {
        return;
      }

      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();

      dragRef.current = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startElX: rect.left,
        startElY: rect.top,
        el,
        didMove: false,
      };

      setWasDragged(false);

      // We don't preventDefault here yet — we do it once we confirm a drag
    },
    [enabled],
  );

  // ------ global mousemove / mouseup ------
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.startMouseX;
      const dy = e.clientY - drag.startMouseY;

      if (!drag.didMove) {
        if (Math.abs(dx) < dragThreshold && Math.abs(dy) < dragThreshold) {
          return; // Below threshold — not a drag yet
        }
        drag.didMove = true;
        setIsDragging(true);
        // Prevent text selection once we start dragging
        document.body.style.userSelect = 'none';
      }

      const rect = drag.el.getBoundingClientRect();
      const newX = drag.startElX + dx;
      const newY = drag.startElY + dy;
      const clamped = clampToViewport(newX, newY, rect.width, rect.height);
      setPosition(clamped);
    };

    const onMouseUp = () => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.didMove) {
        setWasDragged(true);
        document.body.style.userSelect = '';
      }

      dragRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragThreshold]);

  const resetPosition = useCallback(() => {
    setPosition(null);
    setWasDragged(false);
  }, []);

  return { position, isDragging, onMouseDown, wasDragged, resetPosition };
}
