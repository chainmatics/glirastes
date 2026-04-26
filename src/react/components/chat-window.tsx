import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useContext,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChatWindowProps } from '../types.js';
import { useDragResizePanel } from '../hooks/use-drag-resize-panel.js';
import { ChatContext } from '../provider/chat-context.js';

export function ChatWindow({
  children,
  title = 'Assistant',
  closeChatAriaLabel,
  className,
  headerClassName,
  bodyClassName,
  portal = true,
  open,
  defaultOpen = true,
  onOpenChange,
  draggable = true,
  resizable = true,
  constrainToViewport = true,
  width = 420,
  height = 640,
  minWidth = 320,
  minHeight = 420,
  maxWidth,
  maxHeight,
  initialPosition,
  snapToCenter,
  snapRadius,
  edgeThreshold,
  persistDimensions,
  header,
  headerActions,
  headerTitle,
  renderHeader,
  onPositionChange,
  onDimensionChange,
  resizeHandleClassName,
  snapIndicatorClassName,
}: ChatWindowProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;

  // Read theme vars from context if mounted inside a provider. ChatWindow
  // can be used standalone, so fall back to an empty object.
  const ctx = useContext(ChatContext);
  const themeVars = ctx?.themeVars ?? {};
  const themeEffect = ctx?.themeEffect;

  const panelRef = useRef<HTMLElement | null>(null);

  const {
    position,
    size,
    isDragging,
    isResizing,
    activeEdge,
    isNearSnapZone,
    nearEdge,
    handlers,
  } = useDragResizePanel({
    panelRef,
    width,
    height,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    initialPosition,
    snapToCenter,
    snapRadius,
    edgeThreshold,
    persistDimensions,
    draggable,
    resizable,
  });

  // ---------------------------------------------------------------------------
  // Notify position/dimension changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    onPositionChange?.(position);
  }, [position, onPositionChange]);

  useEffect(() => {
    onDimensionChange?.(size);
  }, [size, onDimensionChange]);

  // ---------------------------------------------------------------------------
  // Open/close
  // ---------------------------------------------------------------------------

  const updateOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  const handleClose = useCallback(() => updateOpen(false), [updateOpen]);

  if (!isOpen) return null;

  // ---------------------------------------------------------------------------
  // Position style — always use translate(-50%, 0) so x means "center"
  // ---------------------------------------------------------------------------

  const positionStyle: React.CSSProperties =
    position !== null
      ? { position: 'fixed', left: position.x, top: position.y, transform: 'translate(-50%, 0)' }
      : { position: 'fixed', left: '50%', bottom: 16, transform: 'translate(-50%, 0)' };

  // ---------------------------------------------------------------------------
  // Header rendering
  // ---------------------------------------------------------------------------

  let headerContent: React.ReactNode;

  if (renderHeader) {
    headerContent = renderHeader({
      onClose: handleClose,
      isDragging,
      onDragStart: handlers.onDragStart,
      onDoubleClick: handlers.onDoubleClickHeader,
    });
  } else {
    headerContent = (
      <header
        className={headerClassName}
        data-component="chat-window-header"
        onMouseDown={handlers.onDragStart}
        onDoubleClick={handlers.onDoubleClickHeader}
      >
        {header ?? (
          <>
            <div data-element="title-wrap">
              {headerTitle ?? <strong data-element="title">{title}</strong>}
            </div>
            <div data-element="actions">
              {headerActions}
              <button
                type="button"
                onClick={handleClose}
                data-action="close"
                aria-label={closeChatAriaLabel ?? 'Close chat'}
                title={closeChatAriaLabel ?? 'Close chat'}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </>
        )}
      </header>
    );
  }

  // ---------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------

  const content = (
    <section
      ref={panelRef as React.RefObject<HTMLElement>}
      className={className}
      data-component="chat-window"
      data-theme-effect={themeEffect}
      style={{
        ...themeVars,
        ...positionStyle,
        width: size.width,
        height: size.height,
      }}
      onMouseMove={handlers.onPanelMouseMove}
      onMouseLeave={handlers.onPanelMouseLeave}
    >
      {/* Edge resize handles */}
      {resizable && (
        <>
          <div
            data-component="chat-window-resize-handle"
            data-edge="top"
            className={resizeHandleClassName}
            style={{
              position: 'absolute',
              top: -4,
              left: 16,
              right: 16,
              height: 12,
              cursor: 'ns-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: nearEdge.top || activeEdge === 'top' ? 1 : 0,
              transition: 'opacity 150ms',
              zIndex: 10,
            }}
            onMouseDown={handlers.onEdgeResizeStart('top')}
          />
          <div
            data-component="chat-window-resize-handle"
            data-edge="left"
            className={resizeHandleClassName}
            style={{
              position: 'absolute',
              left: -4,
              top: 16,
              bottom: 16,
              width: 12,
              cursor: 'ew-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: nearEdge.left || activeEdge === 'left' ? 1 : 0,
              transition: 'opacity 150ms',
              zIndex: 10,
            }}
            onMouseDown={handlers.onEdgeResizeStart('left')}
          />
          <div
            data-component="chat-window-resize-handle"
            data-edge="right"
            className={resizeHandleClassName}
            style={{
              position: 'absolute',
              right: -4,
              top: 16,
              bottom: 16,
              width: 12,
              cursor: 'ew-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: nearEdge.right || activeEdge === 'right' ? 1 : 0,
              transition: 'opacity 150ms',
              zIndex: 10,
            }}
            onMouseDown={handlers.onEdgeResizeStart('right')}
          />
        </>
      )}

      {/* Snap-zone indicator */}
      {isDragging && isNearSnapZone && (
        <div
          data-component="chat-window-snap-indicator"
          className={snapIndicatorClassName}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            boxShadow: '0 0 0 3px rgba(99, 102, 241, 0.5)',
          }}
        />
      )}

      {headerContent}

      <div className={bodyClassName} data-component="chat-window-body">
        {children}
      </div>
    </section>
  );

  if (portal && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
