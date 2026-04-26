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
    return stored ? Number(stored) : null;
  } catch {
    return null;
  }
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
        width: storedWidth ?? defaultWidth,
        height: storedHeight ?? defaultHeight,
      };
    }
    return { width: defaultWidth, height: defaultHeight };
  });

  // Sync to incoming prop changes. Without this, the `size` state is
  // frozen at mount time and consumers updating their `size` / `width` /
  // `height` props see no effect until a hard reload.
  useEffect(() => {
    setSize({ width: defaultWidth, height: defaultHeight });
  }, [defaultWidth, defaultHeight]);

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
  } | null>(null);

  const resizeStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    width: number;
    height: number;
    positionX: number | null;
    positionY: number | null;
    edge: 'top' | 'left' | 'right';
  } | null>(null);

  const wasDraggingRef = useRef(false);

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

  const handleDragStart = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!draggable) return;
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button')) return;

      const panel = panelRef.current;
      if (!panel) return;

      const rect = panel.getBoundingClientRect();

      // When position is null (centered), the rendering uses
      // transform: translate(-50%, 0), so x represents the center of the panel.
      // We compute the initial x as rect.left + rect.width / 2 for smooth drag.
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        panelX: position?.x ?? rect.left + rect.width / 2,
        panelY: position?.y ?? rect.top,
      };

      setIsDragging(true);
      e.preventDefault();
    },
    [draggable, panelRef, position],
  );

  const handleDoubleClickHeader = useCallback(() => {
    if (snapToCenter) {
      setPosition(null);
    }
  }, [snapToCenter]);

  // -----------------------------------------------------------------------
  // Edge resize handler (memoized, returns a function per edge)
  // -----------------------------------------------------------------------

  const handleEdgeResizeStart = useCallback(
    (edge: ResizeEdge) =>
      (e: ReactMouseEvent<HTMLElement>) => {
        if (!resizable) return;
        if (e.button !== 0) return;

        const panel = panelRef.current;
        if (!panel) return;

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
        e.preventDefault();
        e.stopPropagation();
      },
    [resizable, panelRef, position],
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
  // Global mouse listeners for active drag / resize
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!isDragging && !isResizing) return;

    // Prevent accidental text selection during drag/resize
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
      if (isDragging && dragStartRef.current) {
        const newX =
          dragStartRef.current.panelX +
          (e.clientX - dragStartRef.current.mouseX);
        const newY =
          dragStartRef.current.panelY +
          (e.clientY - dragStartRef.current.mouseY);

        setPosition({ x: newX, y: newY });

        if (snapToCenter) {
          setIsNearSnapZone(shouldSnapToCenter(newX, newY));
        }
      }

      if (isResizing && resizeStartRef.current) {
        const start = resizeStartRef.current;

        if (start.edge === 'top') {
          const deltaY = start.mouseY - e.clientY;
          let newHeight = start.height + deltaY;
          newHeight = Math.max(minHeight, newHeight);
          if (maxHeight != null) newHeight = Math.min(maxHeight, newHeight);
          const actualDelta = newHeight - start.height;
          setSize((prev) => ({ ...prev, height: newHeight }));
          // Move position up so the bottom edge stays anchored
          if (start.positionY != null) {
            setPosition((prev) => prev ? { ...prev, y: start.positionY! - actualDelta } : prev);
          }
        } else if (start.edge === 'left') {
          const deltaX = start.mouseX - e.clientX;
          let newWidth = start.width + deltaX;
          newWidth = Math.max(minWidth, newWidth);
          if (maxWidth != null) newWidth = Math.min(maxWidth, newWidth);
          const actualDelta = newWidth - start.width;
          setSize((prev) => ({ ...prev, width: newWidth }));
          // Shift center left so the right edge stays anchored
          // (position.x is center due to translate(-50%, 0))
          if (start.positionX != null) {
            setPosition((prev) => prev ? { ...prev, x: start.positionX! - actualDelta / 2 } : prev);
          }
        } else {
          const deltaX = e.clientX - start.mouseX;
          let newWidth = start.width + deltaX;
          newWidth = Math.max(minWidth, newWidth);
          if (maxWidth != null) newWidth = Math.min(maxWidth, newWidth);
          const actualDelta = newWidth - start.width;
          setSize((prev) => ({ ...prev, width: newWidth }));
          // Shift center right so the left edge stays anchored
          if (start.positionX != null) {
            setPosition((prev) => prev ? { ...prev, x: start.positionX! + actualDelta / 2 } : prev);
          }
        }
      }
    };

    const onMouseUp = () => {
      if (isDragging) {
        wasDraggingRef.current = true;
        setIsDragging(false);
        setIsNearSnapZone(false);
        dragStartRef.current = null;
      }
      if (isResizing) {
        setIsResizing(false);
        setActiveEdge(null);
        resizeStartRef.current = null;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [
    isDragging,
    isResizing,
    snapToCenter,
    shouldSnapToCenter,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  ]);

  // -----------------------------------------------------------------------
  // Snap-on-release: detect transition from isDragging=true to false
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!isDragging && wasDraggingRef.current) {
      wasDraggingRef.current = false;
      if (
        snapToCenter &&
        position &&
        shouldSnapToCenter(position.x, position.y)
      ) {
        setPosition(null);
      }
    }
  }, [isDragging, snapToCenter, position, shouldSnapToCenter]);

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
