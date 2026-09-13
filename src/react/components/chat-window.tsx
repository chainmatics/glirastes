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
import { useSidebarResize } from '../hooks/use-sidebar-resize.js';
import { ChatContext } from '../provider/chat-context.js';

export function ChatWindow({
  children,
  title = 'Assistant',
  closeChatAriaLabel,
  className,
  headerClassName,
  bodyClassName,
  portal = true,
  mode,
  defaultMode = 'floating',
  onModeChange,
  layoutControls = false,
  collapsed,
  onCollapsedChange,
  sidebarWidth = 420,
  minSidebarWidth = 320,
  maxSidebarWidth = 800,
  onSidebarWidthChange,
  layoutLabels,
  open,
  keepMounted = false,
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
  persistSidebarWidth = true,
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
  const [uncontrolledMode, setUncontrolledMode] = useState(defaultMode);
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(false);
  const currentMode = mode ?? uncontrolledMode;
  const isSidebar = currentMode === 'sidebar';
  const isCollapsed = isSidebar && (collapsed ?? uncontrolledCollapsed);
  const labels = {
    dock: 'Dock chat', float: 'Float chat', collapse: 'Collapse chat',
    expand: 'Expand chat', resize: 'Resize chat sidebar', ...layoutLabels,
  };
  const updateCollapsed = (value: boolean) => {
    if (collapsed === undefined) setUncontrolledCollapsed(value);
    onCollapsedChange?.(value);
  };
  const toggleMode = () => {
    const next = isSidebar ? 'floating' : 'sidebar';
    if (mode === undefined) setUncontrolledMode(next);
    onModeChange?.(next);
  };

  // Read theme vars from context if mounted inside a provider. ChatWindow
  // can be used standalone, so fall back to an empty object.
  const ctx = useContext(ChatContext);
  const themeVars = ctx?.themeVars ?? {};
  const themeEffect = ctx?.themeEffect;

  const panelRef = useRef<HTMLElement | null>(null);
  const wasCollapsed = useRef(isCollapsed);
  useEffect(() => {
    if (wasCollapsed.current === isCollapsed) return;
    wasCollapsed.current = isCollapsed;
    const panel = panelRef.current;
    if (!panel || !isOpen) return;
    const active = document.activeElement;
    // The expanded rail button is removed; browsers then focus body. Never
    // interrupt an unrelated, still-focused app control on controlled changes.
    if (!panel.contains(active) && !(active === document.body && !isCollapsed)) return;
    const target = isCollapsed
      ? panel.querySelector<HTMLElement>('[data-action="expand"]')
      : panel.querySelector<HTMLElement>('[data-component="chat-window-body"] :is(input:not([disabled]), textarea:not([disabled]), [contenteditable="true"], button:not([disabled]))')
        ?? panel.querySelector<HTMLElement>('[data-component="chat-window-header-slot"] button');
    target?.focus();
  }, [isCollapsed, isOpen]);
  const sidebar = useSidebarResize({
    active: isOpen && isSidebar && !isCollapsed && resizable,
    width: sidebarWidth, minWidth: minSidebarWidth, maxWidth: maxSidebarWidth,
    storageKey: persistDimensions && persistSidebarWidth ? `${persistDimensions === true ? 'chat-panel' : persistDimensions}-sidebar-width` : undefined,
    onWidthChange: onSidebarWidthChange,
  });

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
    draggable: isOpen && !isSidebar && draggable,
    resizable: isOpen && !isSidebar && resizable,
    constrainToViewport,
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
  const handleHeaderDoubleClick = () => {
    if (isOpen && !isSidebar) handlers.onDoubleClickHeader();
  };

  if (!isOpen && !keepMounted) return null;

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
  const controls = layoutControls ? (
    <>
      <button type="button" data-action="layout" onClick={toggleMode}
        aria-label={isSidebar ? labels.float : labels.dock} title={isSidebar ? labels.float : labels.dock}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d={isSidebar ? 'M8 9h8v6H8z' : 'M15 4v16'} />
        </svg>
      </button>
      {isSidebar && <button type="button" data-action="layout" onClick={() => updateCollapsed(true)}
        aria-label={labels.collapse} title={labels.collapse}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>}
    </>
  ) : null;

  if (renderHeader) {
    headerContent = renderHeader({
      layoutControls: controls,
      onClose: handleClose,
      isDragging,
      onDragStart: handlers.onDragStart,
      onDoubleClick: handleHeaderDoubleClick,
    });
  } else {
    headerContent = (
      <header
        className={headerClassName}
        data-component="chat-window-header"
        onMouseDown={handlers.onDragStart}
        onDoubleClick={handleHeaderDoubleClick}
      >
        {header ?? (
          <>
            <div data-element="title-wrap">
              {headerTitle ?? <strong data-element="title">{title}</strong>}
            </div>
            <div data-element="actions">
              {controls}
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
      data-mode={currentMode}
      data-collapsed={isCollapsed || undefined}
      data-theme-effect={themeEffect}
      hidden={!isOpen}
      inert={!isOpen}
      style={{
        ...themeVars,
        ...(isSidebar
          ? { position: portal ? 'fixed' as const : 'relative' as const, right: portal ? 0 : undefined,
              top: portal ? 0 : undefined, transform: 'none', flexShrink: 0, minHeight: 0, maxWidth: '100%' }
          : positionStyle),
        width: isSidebar ? (isCollapsed ? 44 : sidebar.width) : size.width,
        height: isSidebar ? (portal ? '100dvh' : '100%') : size.height,
        display: isOpen ? undefined : 'none',
      }}
      onMouseMove={handlers.onPanelMouseMove}
      onMouseLeave={handlers.onPanelMouseLeave}
    >
      {/* Edge resize handles */}
      {resizable && isSidebar && !isCollapsed && <div
        data-component="chat-window-sidebar-resize" role="separator" tabIndex={0}
        aria-label={labels.resize} aria-orientation="vertical"
        aria-valuemin={sidebar.minimum} aria-valuemax={sidebar.maximum} aria-valuenow={sidebar.width}
        onPointerDown={sidebar.onPointerDown} onKeyDown={sidebar.onKeyDown} onDoubleClick={sidebar.onDoubleClick}
      />}
      {resizable && !isSidebar && (
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

      {isCollapsed && <div data-component="chat-window-rail">
        <button type="button" data-action="expand" onClick={() => updateCollapsed(false)} aria-label={labels.expand} title={labels.expand}>‹</button>
        <span>{title}</span>
        <button type="button" onClick={handleClose} aria-label={closeChatAriaLabel ?? 'Close chat'} title={closeChatAriaLabel ?? 'Close chat'}>×</button>
      </div>}
      <div data-component="chat-window-header-slot" hidden={isCollapsed} inert={isCollapsed}
        style={{ display: isCollapsed ? 'none' : 'contents' }}>
        {headerContent}
      </div>

      <div className={bodyClassName} data-component="chat-window-body" hidden={isCollapsed} inert={isCollapsed}
        style={isCollapsed ? { display: 'none' } : undefined}>
        {children}
      </div>
    </section>
  );

  if (portal && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
