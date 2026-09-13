import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
} from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SNAP_RADIUS = 100;
const DEFAULT_EDGE_THRESHOLD = 20;
const DEFAULT_DRAG_THRESHOLD = 4;
const VIEWPORT_MARGIN = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDragResizePanelOptions {
  panelRef: RefObject<HTMLElement | null>;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maxWidth?: number;
  maxHeight?: number;
  initialPosition?: { x: number; y: number };
  snapToCenter?: boolean;
  snapRadius?: number;
  edgeThreshold?: number;
  persistDimensions?: boolean | string;
  draggable?: boolean;
  resizable?: boolean;
  constrainToViewport?: boolean;
}

export type ResizeEdge = 'top' | 'left' | 'right';

export interface UseDragResizePanelReturn {
  position: { x: number; y: number } | null;
  size: { width: number; height: number };
  isDragging: boolean;
  isResizing: boolean;
  activeEdge: ResizeEdge | null;
  isNearSnapZone: boolean;
  nearEdge: { top: boolean; left: boolean; right: boolean };
  handlers: {
    onDragStart: (e: ReactMouseEvent<HTMLElement>) => void;
    onDoubleClickHeader: () => void;
    onEdgeResizeStart: (
      edge: ResizeEdge,
    ) => (e: ReactMouseEvent<HTMLElement>) => void;
    onPanelMouseMove: (e: ReactMouseEvent<HTMLElement>) => void;
    onPanelMouseLeave: () => void;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSessionNumber(key: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = sessionStorage.getItem(key);
    if (!stored) return null;
    const value = Number(stored);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function clampDimension(
  value: number,
  min: number,
  max?: number,
): number {
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, value));
}

function writeSessionNumber(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore errors from private browsing or quota limits
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDragResizePanel(
  options: UseDragResizePanelOptions,
): UseDragResizePanelReturn {
  const {
    panelRef,
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    initialPosition,
    snapToCenter = false,
    snapRadius = DEFAULT_SNAP_RADIUS,
    edgeThreshold = DEFAULT_EDGE_THRESHOLD,
    persistDimensions = false,
    draggable = true,
    resizable = true,
    constrainToViewport = true,
  } = options;

  const storagePrefix = persistDimensions === true
    ? 'chat-panel'
    : typeof persistDimensions === 'string'
      ? persistDimensions
      : null;

  // -----------------------------------------------------------------------
  // Position state (null = default centered)
  // -----------------------------------------------------------------------

  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => initialPosition ?? null,
  );

  // -----------------------------------------------------------------------
  // Size state (with optional session-storage persistence)
  // -----------------------------------------------------------------------

  const [size, setSize] = useState<{ width: number; height: number }>(() => {
    if (storagePrefix) {
      const storedWidth = readSessionNumber(`${storagePrefix}-width`);
      const storedHeight = readSessionNumber(`${storagePrefix}-height`);
      return {
        width: clampDimension(
          storedWidth ?? defaultWidth,
          minWidth,
          maxWidth,
        ),
        height: clampDimension(
          storedHeight ?? defaultHeight,
          minHeight,
          maxHeight,
        ),
      };
    }
    return {
      width: clampDimension(defaultWidth, minWidth, maxWidth),
      height: clampDimension(defaultHeight, minHeight, maxHeight),
    };
  });
  const previousDefaultsRef = useRef({
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  });

  // Sync to incoming prop changes. Without this, the `size` state is
  // frozen at mount time and consumers updating their `size` / `width` /
  // `height` props see no effect until a hard reload. Do not write on the
  // initial effect: that would immediately erase restored session dimensions.
  useEffect(() => {
    const previous = previousDefaultsRef.current;
    if (
      previous.width === defaultWidth
      && previous.height === defaultHeight
      && previous.minWidth === minWidth
      && previous.minHeight === minHeight
      && previous.maxWidth === maxWidth
      && previous.maxHeight === maxHeight
    ) {
      return;
    }
    previousDefaultsRef.current = {
      width: defaultWidth,
      height: defaultHeight,
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
    };
    setSize({
      width: clampDimension(defaultWidth, minWidth, maxWidth),
      height: clampDimension(defaultHeight, minHeight, maxHeight),
    });
  }, [
    defaultWidth,
    defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  ]);

  // -----------------------------------------------------------------------
  // Interaction states
  // -----------------------------------------------------------------------

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [activeEdge, setActiveEdge] = useState<ResizeEdge | null>(null);
  const [isNearSnapZone, setIsNearSnapZone] = useState(false);
  const [nearEdge, setNearEdge] = useState<{
    top: boolean;
    left: boolean;
    right: boolean;
  }>({ top: false, left: false, right: false });

  // -----------------------------------------------------------------------
  // Refs for drag/resize start state (mutable, never trigger re-renders)
  // -----------------------------------------------------------------------

  const dragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    panelX: number;
    panelY: number;
    currentX: number;
    currentY: number;
    panelWidth: number;
    panelHeight: number;
    started: boolean;
  } | null>(null);
  const dragListenerCleanupRef = useRef<(() => void) | null>(null);
  const dragUserSelectRef = useRef<string | null>(null);

  const resizeStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    width: number;
    height: number;
    positionX: number | null;
    positionY: number | null;
    edge: 'top' | 'left' | 'right';
  } | null>(null);
  const resizeListenerCleanupRef = useRef<(() => void) | null>(null);
  const resizeUserSelectRef = useRef<string | null>(null);

  // -----------------------------------------------------------------------
  // Snap-to-center helpers
  // -----------------------------------------------------------------------

  const shouldSnapToCenter = useCallback(
    (x: number, _y: number) => {
      if (!snapToCenter || typeof window === 'undefined') return false;
      const panel = panelRef.current;
      if (!panel) return false;

      const viewportCenterX = window.innerWidth / 2;
      const panelHeight = panel.getBoundingClientRect().height;
      const defaultY = window.innerHeight - 16 - panelHeight;

      return (
        Math.abs(x - viewportCenterX) < snapRadius &&
        Math.abs(_y - defaultY) < snapRadius
      );
    },
    [snapToCenter, panelRef, snapRadius],
  );

  // -----------------------------------------------------------------------
  // Drag handlers
  // -----------------------------------------------------------------------

  const constrainPosition = useCallback((
    x: number,
    y: number,
    panelWidth: number,
    panelHeight: number,
  ) => {
    if (!constrainToViewport || typeof window === 'undefined') {
      return { x, y };
    }

    const constrainedX = panelWidth + (VIEWPORT_MARGIN * 2) >= window.innerWidth
      ? window.innerWidth / 2
      : Math.min(
          window.innerWidth - (panelWidth / 2) - VIEWPORT_MARGIN,
          Math.max((panelWidth / 2) + VIEWPORT_MARGIN, x),
        );
    const constrainedY = panelHeight + (VIEWPORT_MARGIN * 2) >= window.innerHeight
      ? VIEWPORT_MARGIN
      : Math.min(
          window.innerHeight - panelHeight - VIEWPORT_MARGIN,
          Math.max(VIEWPORT_MARGIN, y),
        );
    return { x: constrainedX, y: constrainedY };
  }, [constrainToViewport]);

  const releaseDragResources = useCallback(() => {
    dragListenerCleanupRef.current?.();
    dragListenerCleanupRef.current = null;
    if (dragUserSelectRef.current !== null) {
      document.body.style.userSelect = dragUserSelectRef.current;
      dragUserSelectRef.current = null;
    }
    dragStartRef.current = null;
  }, []);

  const handleDragStart = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!draggable) return;
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button')) return;

      const panel = panelRef.current;
      if (!panel) return;

      releaseDragResources();
      const rect = panel.getBoundingClientRect();

      // When position is null (centered), the rendering uses
      // transform: translate(-50%, 0), so x represents the center of the panel.
      // We compute the initial x as rect.left + rect.width / 2 for smooth drag.
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        panelX: position?.x ?? rect.left + rect.width / 2,
        panelY: position?.y ?? rect.top,
        currentX: position?.x ?? rect.left + rect.width / 2,
        currentY: position?.y ?? rect.top,
        panelWidth: rect.width,
        panelHeight: rect.height,
        started: false,
      };

      const onMouseMove = (event: MouseEvent) => {
        const drag = dragStartRef.current;
        if (!drag) return;

        const deltaX = event.clientX - drag.mouseX;
        const deltaY = event.clientY - drag.mouseY;
        if (
          !drag.started
          && Math.hypot(deltaX, deltaY) < DEFAULT_DRAG_THRESHOLD
        ) {
          return;
        }

        if (!drag.started) {
          drag.started = true;
          dragUserSelectRef.current = document.body.style.userSelect;
          document.body.style.userSelect = 'none';
          setIsDragging(true);
        }

        const constrained = constrainPosition(
          drag.panelX + deltaX,
          drag.panelY + deltaY,
          drag.panelWidth,
          drag.panelHeight,
        );
        drag.currentX = constrained.x;
        drag.currentY = constrained.y;
        setPosition({ x: drag.currentX, y: drag.currentY });
        if (snapToCenter) {
          setIsNearSnapZone(
            shouldSnapToCenter(drag.currentX, drag.currentY),
          );
        }
        event.preventDefault();
      };

      const onMouseUp = () => {
        const drag = dragStartRef.current;
        const shouldSnap = Boolean(
          drag?.started
          && snapToCenter
          && shouldSnapToCenter(drag.currentX, drag.currentY),
        );
        releaseDragResources();
        setIsDragging(false);
        setIsNearSnapZone(false);
        if (shouldSnap) setPosition(null);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      dragListenerCleanupRef.current = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
    },
    [
      draggable,
      panelRef,
      position,
      constrainPosition,
      releaseDragResources,
      snapToCenter,
      shouldSnapToCenter,
    ],
  );

  const handleDoubleClickHeader = useCallback(() => {
    releaseDragResources();
    setIsDragging(false);
    setIsNearSnapZone(false);
    if (snapToCenter) {
      setPosition(null);
    }
  }, [releaseDragResources, snapToCenter]);

  useEffect(() => () => {
    dragListenerCleanupRef.current?.();
    if (dragUserSelectRef.current !== null) {
      document.body.style.userSelect = dragUserSelectRef.current;
    }
    resizeListenerCleanupRef.current?.();
    if (resizeUserSelectRef.current !== null) {
      document.body.style.userSelect = resizeUserSelectRef.current;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Edge resize handler (memoized, returns a function per edge)
  // -----------------------------------------------------------------------

  const releaseResizeResources = useCallback(() => {
    resizeListenerCleanupRef.current?.();
    resizeListenerCleanupRef.current = null;
    if (resizeUserSelectRef.current !== null) {
      document.body.style.userSelect = resizeUserSelectRef.current;
      resizeUserSelectRef.current = null;
    }
    resizeStartRef.current = null;
  }, []);

  // A retained panel can become inactive without unmounting. Release document
  // listeners and selection locks immediately, rather than waiting for mouseup.
  useEffect(() => {
    if (!draggable) {
      releaseDragResources();
      setIsDragging(false);
      setIsNearSnapZone(false);
    }
    if (!resizable) {
      releaseResizeResources();
      setIsResizing(false);
      setActiveEdge(null);
    }
  }, [draggable, resizable, releaseDragResources, releaseResizeResources]);

  const handleEdgeResizeStart = useCallback(
    (edge: ResizeEdge) =>
      (e: ReactMouseEvent<HTMLElement>) => {
        if (!resizable) return;
        if (e.button !== 0) return;

        const panel = panelRef.current;
        if (!panel) return;

        releaseResizeResources();
        const rect = panel.getBoundingClientRect();

        resizeStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          width: rect.width,
          height: rect.height,
          positionX: position?.x ?? rect.left + rect.width / 2,
          positionY: position?.y ?? rect.top,
          edge,
        };

        setIsResizing(true);
        setActiveEdge(edge);
        resizeUserSelectRef.current = document.body.style.userSelect;
        document.body.style.userSelect = 'none';

        const onMouseMove = (event: MouseEvent) => {
          const start = resizeStartRef.current;
          if (!start) return;

          if (start.edge === 'top') {
            const deltaY = start.mouseY - event.clientY;
            let newHeight = start.height + deltaY;
            newHeight = Math.max(minHeight, newHeight);
            if (maxHeight != null) newHeight = Math.min(maxHeight, newHeight);
            const actualDelta = newHeight - start.height;
            setSize((prev) => ({ ...prev, height: newHeight }));
            if (start.positionY != null) {
              setPosition((prev) => prev
                ? { ...prev, y: start.positionY! - actualDelta }
                : prev);
            }
          } else if (start.edge === 'left') {
            const deltaX = start.mouseX - event.clientX;
            let newWidth = start.width + deltaX;
            newWidth = Math.max(minWidth, newWidth);
            if (maxWidth != null) newWidth = Math.min(maxWidth, newWidth);
            const actualDelta = newWidth - start.width;
            setSize((prev) => ({ ...prev, width: newWidth }));
            if (start.positionX != null) {
              setPosition((prev) => prev
                ? { ...prev, x: start.positionX! - actualDelta / 2 }
                : prev);
            }
          } else {
            const deltaX = event.clientX - start.mouseX;
            let newWidth = start.width + deltaX;
            newWidth = Math.max(minWidth, newWidth);
            if (maxWidth != null) newWidth = Math.min(maxWidth, newWidth);
            const actualDelta = newWidth - start.width;
            setSize((prev) => ({ ...prev, width: newWidth }));
            if (start.positionX != null) {
              setPosition((prev) => prev
                ? { ...prev, x: start.positionX! + actualDelta / 2 }
                : prev);
            }
          }
          event.preventDefault();
        };

        const onMouseUp = () => {
          releaseResizeResources();
          setIsResizing(false);
          setActiveEdge(null);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        resizeListenerCleanupRef.current = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };
        e.preventDefault();
        e.stopPropagation();
      },
    [
      resizable,
      panelRef,
      position,
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
      releaseResizeResources,
    ],
  );

  // -----------------------------------------------------------------------
  // Edge detection
  // -----------------------------------------------------------------------

  const handlePanelMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!panel || isDragging || isResizing) return;

      const rect = panel.getBoundingClientRect();
      setNearEdge({
        top: e.clientY - rect.top < edgeThreshold,
        left: e.clientX - rect.left < edgeThreshold,
        right: e.clientX - rect.left > rect.width - edgeThreshold,
      });
    },
    [panelRef, isDragging, isResizing, edgeThreshold],
  );

  const handlePanelMouseLeave = useCallback(() => {
    if (!isDragging && !isResizing) {
      setNearEdge({ top: false, left: false, right: false });
    }
  }, [isDragging, isResizing]);

  // -----------------------------------------------------------------------
  // Persist dimensions to sessionStorage
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (storagePrefix) {
      writeSessionNumber(`${storagePrefix}-width`, size.width);
      writeSessionNumber(`${storagePrefix}-height`, size.height);
    }
  }, [storagePrefix, size.width, size.height]);

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    position,
    size,
    isDragging,
    isResizing,
    activeEdge,
    isNearSnapZone,
    nearEdge,
    handlers: {
      onDragStart: handleDragStart,
      onDoubleClickHeader: handleDoubleClickHeader,
      onEdgeResizeStart: handleEdgeResizeStart,
      onPanelMouseMove: handlePanelMouseMove,
      onPanelMouseLeave: handlePanelMouseLeave,
    },
  };
}
