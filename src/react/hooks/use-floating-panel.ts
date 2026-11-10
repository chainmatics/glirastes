import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Compass edge or corner a resize handle sits on. */
export type FloatingResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface UseFloatingPanelOptions {
  /** False keeps the hook inert, for a panel that is docked right now. Default: true. */
  enabled?: boolean;
  /** Where the panel opens the first time and after `reset()`. */
  defaultRect: FloatingRect | (() => FloatingRect);
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Gap the panel keeps to the viewport edges. Default: 8. */
  margin?: number;
  /** localStorage key that remembers position and size. */
  storageKey?: string;
  /** Pixels one arrow key press moves or resizes; Shift takes four steps. Default: 16. */
  keyboardStep?: number;
}

export interface UseFloatingPanelReturn<T extends HTMLElement> {
  ref: RefObject<T | null>;
  /** Committed position and size; null while disabled or before the first measure. */
  rect: FloatingRect | null;
  /** Fixed-position style for the panel element; undefined while `rect` is null. */
  style: CSSProperties | undefined;
  /** Spread on the element the panel is moved by, usually its header. */
  dragHandleProps: {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
    onDoubleClick(event: { target: EventTarget | null }): void;
  };
  /** Props for a resize handle on the given edge or corner. */
  getResizeHandleProps(edge: FloatingResizeEdge): {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    'data-resize-edge': FloatingResizeEdge;
  };
  /** Back to the default rect. */
  reset(): void;
}

interface Limits {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  margin: number;
}

const INTERACTIVE = 'button,a,input,select,textarea,[contenteditable="true"],[role="combobox"],[role="separator"],[data-no-drag]';

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Size within the limits and the viewport, then position within the viewport. */
function fit(rect: FloatingRect, limits: Limits): FloatingRect {
  const view = viewport();
  const roomX = Math.max(0, view.width - limits.margin * 2);
  const roomY = Math.max(0, view.height - limits.margin * 2);
  const width = Math.round(Math.min(Math.max(rect.width, limits.minWidth), limits.maxWidth, roomX));
  const height = Math.round(Math.min(Math.max(rect.height, limits.minHeight), limits.maxHeight, roomY));
  const x = Math.round(Math.min(Math.max(rect.x, limits.margin), Math.max(limits.margin, view.width - limits.margin - width)));
  const y = Math.round(Math.min(Math.max(rect.y, limits.margin), Math.max(limits.margin, view.height - limits.margin - height)));
  return { x, y, width, height };
}

/** The rect after dragging `edge` by the given distance; the opposite edge stays put. */
function resized(start: FloatingRect, edge: FloatingResizeEdge, dx: number, dy: number, limits: Limits): FloatingRect {
  const view = viewport();
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const clampWidth = (width: number) => Math.min(Math.max(width, limits.minWidth), limits.maxWidth);
  const clampHeight = (height: number) => Math.min(Math.max(height, limits.minHeight), limits.maxHeight);
  if (edge.includes('e')) right = Math.min(left + clampWidth(start.width + dx), view.width - limits.margin);
  if (edge.includes('w')) left = Math.max(right - clampWidth(start.width - dx), limits.margin);
  if (edge.includes('s')) bottom = Math.min(top + clampHeight(start.height + dy), view.height - limits.margin);
  if (edge.includes('n')) top = Math.max(bottom - clampHeight(start.height - dy), limits.margin);
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

function readStored(key: string | undefined): FloatingRect | null {
  if (!key) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<FloatingRect> | null;
    if (!value) return null;
    const { x, y, width, height } = value;
    return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { x: x as number, y: y as number, width: width as number, height: height as number }
      : null;
  } catch {
    return null;
  }
}

/**
 * Position and size of a floating panel: moved by a handle, resized from any
 * edge or corner, by pointer (mouse, touch, pen) or keyboard.
 *
 * A gesture writes straight to the element once per frame and commits to
 * React state when it ends, so the panel's content does not render while it
 * follows the pointer. The panel stays inside the viewport, also when the
 * window shrinks.
 */
export function useFloatingPanel<T extends HTMLElement = HTMLDivElement>(
  options: UseFloatingPanelOptions,
): UseFloatingPanelReturn<T> {
  const {
    enabled = true,
    minWidth = 0,
    minHeight = 0,
    maxWidth = Number.POSITIVE_INFINITY,
    maxHeight = Number.POSITIVE_INFINITY,
    margin = 8,
    storageKey,
    keyboardStep = 16,
  } = options;
  const ref = useRef<T | null>(null);
  const [rect, setRect] = useState<FloatingRect | null>(null);
  const rectRef = useRef<FloatingRect | null>(null);
  const endGesture = useRef<(() => void) | null>(null);

  const limits = useMemo<Limits>(
    () => ({ minWidth, minHeight, maxWidth, maxHeight, margin }),
    [minWidth, minHeight, maxWidth, maxHeight, margin],
  );
  const defaultRectRef = useRef(options.defaultRect);
  defaultRectRef.current = options.defaultRect;
  const resolveDefault = useCallback(() => {
    const value = defaultRectRef.current;
    return typeof value === 'function' ? value() : value;
  }, []);

  const commit = useCallback((next: FloatingRect) => {
    const fitted = fit(next, limits);
    rectRef.current = fitted;
    setRect(fitted);
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(fitted)); } catch { /* storage unavailable */ }
    }
  }, [limits, storageKey]);

  // Storage and viewport are read after mount, never during the first render.
  useEffect(() => {
    if (!enabled) {
      endGesture.current?.();
      rectRef.current = null;
      setRect(null);
      return;
    }
    const initial = fit(readStored(storageKey) ?? resolveDefault(), limits);
    rectRef.current = initial;
    setRect(initial);
    const refit = () => {
      if (rectRef.current && !endGesture.current) commit(rectRef.current);
    };
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [enabled, storageKey, limits, resolveDefault, commit]);

  useEffect(() => () => endGesture.current?.(), []);

  const startGesture = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    edge: FloatingResizeEdge | null,
  ) => {
    const element = ref.current;
    const start = rectRef.current;
    if (!enabled || !element || !start || event.button !== 0) return;
    if (!edge && (event.target as HTMLElement).closest(INTERACTIVE)) return;
    event.preventDefault();
    endGesture.current?.();

    const handle = event.currentTarget;
    const { pointerId, clientX: startX, clientY: startY } = event;
    let next = start;
    let frame = 0;
    const body = document.body;
    const previousSelect = body.style.userSelect;
    const previousCursor = body.style.cursor;
    body.style.userSelect = 'none';
    if (!edge) body.style.cursor = 'grabbing';
    element.dataset.floatingGesture = edge ? 'resize' : 'move';
    try { handle.setPointerCapture?.(pointerId); } catch { /* pointer already gone */ }

    const paint = () => {
      frame = 0;
      if (edge) {
        element.style.left = `${next.x}px`;
        element.style.top = `${next.y}px`;
        element.style.width = `${next.width}px`;
        element.style.height = `${next.height}px`;
      } else {
        element.style.transform = `translate3d(${next.x - start.x}px, ${next.y - start.y}px, 0)`;
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      next = edge
        ? resized(start, edge, dx, dy, limits)
        : fit({ ...start, x: start.x + dx, y: start.y + dy }, limits);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      window.removeEventListener('blur', finish);
      try { handle.releasePointerCapture?.(pointerId); } catch { /* not captured */ }
      body.style.userSelect = previousSelect;
      body.style.cursor = previousCursor;
      delete element.dataset.floatingGesture;
      endGesture.current = null;
      // Land on the final rect in the same frame the transform goes away.
      element.style.transform = '';
      element.style.left = `${next.x}px`;
      element.style.top = `${next.y}px`;
      commit(next);
    };
    endGesture.current = finish;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    window.addEventListener('blur', finish);
  }, [enabled, limits, commit]);

  const reset = useCallback(() => {
    if (enabled) commit(resolveDefault());
  }, [enabled, commit, resolveDefault]);

  const dragHandleProps = useMemo(() => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startGesture(event, null),
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      const current = rectRef.current;
      if (!enabled || !current || event.target !== event.currentTarget) return;
      const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[event.key];
      if (!direction) return;
      event.preventDefault();
      const step = keyboardStep * (event.shiftKey ? 4 : 1);
      const [dx, dy] = [direction[0] * step, direction[1] * step];
      commit(event.altKey
        ? resized(current, 'se', dx, dy, limits)
        : { ...current, x: current.x + dx, y: current.y + dy });
    },
    onDoubleClick: (event: { target: EventTarget | null }) => {
      if (event.target instanceof HTMLElement && event.target.closest(INTERACTIVE)) return;
      reset();
    },
  }), [enabled, keyboardStep, limits, commit, reset, startGesture]);

  const getResizeHandleProps = useCallback((edge: FloatingResizeEdge) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startGesture(event, edge),
    'data-resize-edge': edge,
  }), [startGesture]);

  const style = useMemo<CSSProperties | undefined>(
    () => rect
      ? { position: 'fixed', left: rect.x, top: rect.y, width: rect.width, height: rect.height }
      : undefined,
    [rect],
  );

  return { ref, rect, style, dragHandleProps, getResizeHandleProps, reset };
}
