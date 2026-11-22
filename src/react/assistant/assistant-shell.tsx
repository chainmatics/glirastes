'use client';

import '../styles.css';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChatContext } from '../provider/chat-context.js';
import { formatShortcut, useChatShortcuts, type ChatShortcutMap } from '../hooks/use-chat-shortcuts.js';
import { useFloatingPanel, type FloatingResizeEdge } from '../hooks/use-floating-panel.js';
import { isGerman, usePageLanguage } from '../utils/tool-presentation.js';
import { SessionSwitcher } from '../components/session-switcher.js';
import { useAssistantLayout, type AssistantLayoutMode } from './assistant-layout.js';
import { AssistantModeMenu } from './assistant-mode-menu.js';
import { useModalSurface } from './use-modal-surface.js';

/** A built-in button of the shell, for `renderButton`. */
export type AssistantShellAction = 'bubble' | 'toggle' | 'detach' | 'dock' | 'collapse' | 'clear' | 'close' | 'mode' | 'history';

export interface AssistantShellButtonProps {
  action: AssistantShellAction;
  /** Accessible name. */
  label: string;
  /** Tooltip, with the shortcut where there is one. */
  title: string;
  pressed?: boolean;
  /** `aria-expanded` of a button that opens a menu or a column (`mode`, `history`). */
  expanded?: boolean;
  /** Id of what the button opens, for `aria-controls`. */
  controls?: string;
  onClick(): void;
  /** The icon, plus the visible label for `toggle`. */
  children: ReactNode;
  className?: string;
}

export interface AssistantShellIcons {
  assistant: ReactNode;
  detach: ReactNode;
  dock: ReactNode;
  collapse: ReactNode;
  clear: ReactNode;
  close: ReactNode;
  /** Full screen entry of the layout menu. */
  fullscreen?: ReactNode;
  /** Toggle of the chat column in full screen. */
  history?: ReactNode;
}

export interface AssistantShellLabels {
  /** Name of the assistant: landmark, bubble and the collapsed rail. */
  title: string;
  /** Label of `AssistantToggle`. */
  toggle: string;
  expand: string;
  collapse: string;
  detach: string;
  dock: string;
  clear: string;
  close: string;
  resize: string;
  /** Accessible name of the draggable header of the detached window. */
  windowHeader: string;
  /** Name of the layout menu button. */
  layout?: string;
  /** Layout menu entries. */
  sidebar?: string;
  floating?: string;
  /** The full-screen layout, e.g. in the layout menu. */
  fullscreen?: string;
  /** Title of the chat column in full screen. */
  history?: string;
  /** Toggle of the chat column. */
  showHistory?: string;
  hideHistory?: string;
}

export interface AssistantShellClassNames {
  root: string;
  sidebar: string;
  floating: string;
  header: string;
  body: string;
  button: string;
  bubble: string;
  toggle: string;
  rail: string;
  railExpand: string;
  resizeHandle: string;
  windowHandle: string;
}

export const DEFAULT_ASSISTANT_SHELL_LABELS: AssistantShellLabels = Object.freeze({
  title: 'AI assistant',
  toggle: 'Ask AI',
  expand: 'Expand AI assistant',
  collapse: 'Collapse',
  detach: 'Detach as window',
  dock: 'Dock right',
  clear: 'Clear chat',
  close: 'Close',
  resize: 'AI assistant width',
  windowHeader: 'Chat window: arrow keys move, Alt and arrow keys resize, double click resets',
  layout: 'Layout',
  sidebar: 'Sidebar',
  floating: 'Window',
  fullscreen: 'Full screen',
  history: 'Chats',
  showHistory: 'Show chats',
  hideHistory: 'Hide chats',
});

export const DE_ASSISTANT_SHELL_LABELS: AssistantShellLabels = Object.freeze({
  title: 'KI-Assistent',
  toggle: 'KI fragen',
  expand: 'KI-Assistent ausklappen',
  collapse: 'Einklappen',
  detach: 'Als Fenster lösen',
  dock: 'Rechts andocken',
  clear: 'Chatverlauf löschen',
  close: 'Schließen',
  resize: 'Breite des KI-Assistenten',
  windowHeader: 'Chatfenster: Pfeiltasten verschieben, Alt und Pfeiltasten ändern die Größe, Doppelklick setzt zurück',
  layout: 'Ansicht',
  sidebar: 'Seitenleiste',
  floating: 'Fenster',
  fullscreen: 'Vollbild',
  history: 'Chats',
  showHistory: 'Chats einblenden',
  hideHistory: 'Chats ausblenden',
});

/** The built-in labels for the language of the page; an app's own `labels` still override them. */
export function assistantShellLabelsFor(language: string | null | undefined): AssistantShellLabels {
  return isGerman(language) ? DE_ASSISTANT_SHELL_LABELS : DEFAULT_ASSISTANT_SHELL_LABELS;
}

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const DEFAULT_ASSISTANT_SHELL_ICONS: AssistantShellIcons = {
  assistant: svg(<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />),
  detach: svg(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>),
  dock: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>),
  collapse: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /><path d="m8 9 3 3-3 3" /></>),
  clear: svg(<><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></>),
  close: svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  fullscreen: svg(<><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 15v6h-6" /><path d="M3 9V3h6" /></>),
  history: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>),
};

export interface AssistantShellWindowOptions {
  /** Default: the sidebar width. */
  width?: number;
  /** Default: 600, at most the viewport height minus 88. */
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Gap to the right and bottom edge where the window first opens. Default: 16 and 72. */
  right?: number;
  bottom?: number;
  /** localStorage key for position and size; `null` keeps them in memory. Default: `glirastes:assistant-window:v1`. */
  storageKey?: string | null;
}

export interface AssistantShellProps {
  /** The conversation, usually an `AiChatPanel` or the app's own chat. */
  children: ReactNode;
  /** Before the title, e.g. the app's navigation button on phones. */
  headerStart?: ReactNode;
  /** Replaces the plain title, e.g. with a session switcher. */
  headerTitle?: ReactNode;
  /** Extra buttons before the built-in ones. */
  headerActions?: ReactNode;
  icons?: Partial<AssistantShellIcons>;
  labels?: Partial<AssistantShellLabels>;
  classNames?: Partial<AssistantShellClassNames>;
  style?: CSSProperties;
  /** Render every built-in button with the app's own button component. */
  renderButton?: (props: AssistantShellButtonProps) => ReactNode;
  /** Round button bottom right that opens the detached window. Default: true. */
  showBubble?: boolean;
  showClearButton?: boolean;
  /** Default: `clear()` of the surrounding chat provider. */
  onClear?: () => void;
  /** Handler of the new-chat shortcut. Default: a new chat when the chat keeps several, otherwise the shortcut stays off. */
  onNewChat?: () => void;
  /** The app's own key combinations; see `DEFAULT_CHAT_SHORTCUTS`. */
  shortcuts?: ChatShortcutMap;
  /** Return true to let a key press pass, e.g. while a dialog owns the keyboard. */
  shouldIgnoreShortcut?: (event: KeyboardEvent) => boolean;
  window?: AssistantShellWindowOptions;
  /**
   * Sibling of the shell that holds the page. On narrow screens the docked
   * assistant hides it and takes the whole row. Default: `[data-assistant-main]`.
   */
  mainSelector?: string;
  /** CSS custom property on `<html>` with the width the docked assistant covers; `false` sets none. */
  insetProperty?: string | false;
  /** Remaining row width below which the docked assistant fills the row. Default: 840. */
  narrowWidth?: number;
  /**
   * Page width the docked assistant always leaves free. The widest sidebar
   * is `min(maxWidth, row − minPageWidth)`, never below `minWidth`. Default 0
   * (as before). Below `narrowWidth` the assistant still takes the whole row.
   */
  minPageWidth?: number;
  /** Width of the collapsed rail. Default: 44. */
  railWidth?: number;
  /**
   * Layouts the user can choose. Default `['sidebar', 'floating']`: the
   * detach/dock button as before. With `'fullscreen'` a layout menu replaces
   * detach/dock. One entry: no layout control and no layout shortcut. A
   * current layout outside the list falls back (full screen → `restoreMode()`,
   * otherwise the first entry).
   */
  modes?: ReadonlyArray<AssistantLayoutMode>;
  /**
   * Left column in full screen. Default: the chat list (`SessionSwitcher
   * variant="list"`) when the chat keeps several; `false` shows none; any
   * node replaces it. 260 px wide; below 900 px viewport width a drawer
   * opened from the header.
   */
  historyPane?: ReactNode | false;
}

const NARROW_SCREEN = '(max-width: 899.98px)';
/** Whether a media query matches; false on the server and without `matchMedia` (jsdom). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    list.addListener?.(update);
    return () => list.removeListener?.(update);
  }, [query]);
  return matches;
}

/** `inert` as a DOM attribute, the same in React 18 and 19. */
function useInert(ref: { current: HTMLElement | null }, inert: boolean) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (inert) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  });
}

const DEFAULT_MODES: ReadonlyArray<AssistantLayoutMode> = ['sidebar', 'floating'];
const LAYOUT_MODES: ReadonlyArray<AssistantLayoutMode> = ['sidebar', 'floating', 'fullscreen'];
function modesOf(modes: ReadonlyArray<AssistantLayoutMode> | undefined): ReadonlyArray<AssistantLayoutMode> {
  const valid = (modes ?? DEFAULT_MODES).filter((mode, index, all) => LAYOUT_MODES.includes(mode) && all.indexOf(mode) === index);
  return valid.length ? valid : DEFAULT_MODES;
}

const WINDOW_EDGES: FloatingResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const EDGE_CURSOR: Record<FloatingResizeEdge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
/** Inline, so the handles work in unstyled mode too. Edges leave the corners free. */
function edgeStyle(edge: FloatingResizeEdge): CSSProperties {
  const style: CSSProperties = { position: 'absolute', zIndex: 2, touchAction: 'none', cursor: EDGE_CURSOR[edge] };
  if (edge === 'n' || edge === 's') Object.assign(style, { left: 12, right: 12, height: 8 });
  else if (edge === 'e' || edge === 'w') Object.assign(style, { top: 12, bottom: 12, width: 8 });
  else Object.assign(style, { width: 16, height: 16 });
  if (edge.includes('n')) style.top = -4;
  if (edge.includes('s')) style.bottom = -4;
  if (edge.includes('e')) style.right = -4;
  if (edge.includes('w')) style.left = -4;
  return style;
}
const withShortcut = (label: string, combo: string | false) => combo ? `${label} (${formatShortcut(combo)})` : label;
const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ') || undefined;

function defaultButton(unstyled: boolean | undefined) {
  return function DefaultButton({ action, label, title, pressed, expanded, controls, onClick, children, className }: AssistantShellButtonProps) {
    // Bubble and toggle live outside the shell, so they carry their own component name and styling switch.
    const standalone = action === 'bubble' || action === 'toggle';
    return (
      <button type="button" data-component={standalone ? `assistant-${action}` : undefined}
        data-action={standalone ? undefined : action} data-unstyled={(standalone && unstyled) || undefined}
        className={className} aria-label={label} title={title} aria-pressed={pressed}
        aria-haspopup={action === 'mode' ? 'menu' : undefined} aria-expanded={expanded} aria-controls={controls}
        onClick={onClick}>{children}</button>
    );
  };
}

/** Opens and closes the assistant, e.g. from the app's top bar. */
export function AssistantToggle({ icon, label, className, showLabel = true, renderButton }: {
  icon?: ReactNode;
  label?: string;
  className?: string;
  /** Visible text next to the icon. Default: true. */
  showLabel?: boolean;
  renderButton?: (props: AssistantShellButtonProps) => ReactNode;
}) {
  const layout = useAssistantLayout();
  const unstyled = useContext(ChatContext)?.unstyled;
  const text = label ?? assistantShellLabelsFor(usePageLanguage()).toggle;
  return (renderButton ?? defaultButton(unstyled))({
    action: 'toggle', label: text, title: text, pressed: layout.open, onClick: layout.toggleChat, className,
    children: <>{icon ?? DEFAULT_ASSISTANT_SHELL_ICONS.assistant}{showLabel && <span data-element="label">{text}</span>}</>,
  });
}

/** Sidebar width handle; the gesture writes to the DOM and commits once at the end. */
function SidebarResizeHandle({ label, width, min, max, defaultWidth, className, onCommit, onPreview }: {
  label: string; width: number; min: number; max: number; defaultWidth: number; className?: string;
  onCommit(width: number): void; onPreview(width: number): void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    data-component="assistant-shell-resize" className={className}
    // An app class owns the handle completely; without one it is placed inline, also when unstyled.
    style={className ? undefined : { position: 'absolute', top: 0, bottom: 0, left: -4, width: 8, zIndex: 2, cursor: 'col-resize', touchAction: 'none' }}
    onDoubleClick={() => onCommit(defaultWidth)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      onCommit(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(width + (event.key === 'ArrowLeft' ? 20 : -20)));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      cleanup.current?.();
      const handle = event.currentTarget;
      const startX = event.clientX;
      let next = width, frame = 0;
      const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      document.body.dataset.panelResizing = 'true';
      handle.dataset.dragging = 'true';
      const move = (e: PointerEvent) => {
        next = clamp(width + startX - e.clientX);
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; onPreview(next); handle.setAttribute('aria-valuenow', String(next)); });
      };
      const finish = () => {
        cancelAnimationFrame(frame);
        delete handle.dataset.dragging; delete document.body.dataset.panelResizing;
        document.body.style.cursor = cursor; document.body.style.userSelect = selection;
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', finish);
        cleanup.current = null;
        onPreview(next); onCommit(next);
      };
      cleanup.current = finish;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish); window.addEventListener('blur', finish);
    }} />;
}

/**
 * The assistant as a right sidebar that takes its share of the page row,
 * or as a detached window that is moved by its header and resized from
 * every edge. Layout, width and window position persist. Place it as the
 * last child of the row that holds the page (`[data-assistant-main]`),
 * inside an `AssistantLayoutProvider`. Every icon, label, class and button
 * can be replaced; the shipped look follows the chat theme and switches
 * off with the provider's `unstyled`.
 */
export function AssistantShell({
  children,
  headerStart,
  headerTitle,
  headerActions,
  icons: iconOverrides,
  labels: labelOverrides,
  classNames = {},
  style,
  renderButton,
  showBubble = true,
  showClearButton = true,
  onClear,
  onNewChat,
  shortcuts: shortcutOverrides,
  shouldIgnoreShortcut,
  window: windowOptions = {},
  mainSelector = '[data-assistant-main]',
  insetProperty = '--assistant-right-inset',
  narrowWidth = 840,
  minPageWidth = 0,
  railWidth = 44,
  modes: modesProp,
  historyPane,
}: AssistantShellProps) {
  const ui = useAssistantLayout();
  const chat = useContext(ChatContext);
  const icons = { ...DEFAULT_ASSISTANT_SHELL_ICONS, ...iconOverrides };
  const labels = { ...assistantShellLabelsFor(usePageLanguage()), ...labelOverrides };
  const sessionsSupported = useContext(ChatContext)?.sessionsSupported === true;
  const render = renderButton ?? defaultButton(chat?.unstyled);
  const button = (props: Omit<AssistantShellButtonProps, 'className'>) =>
    render({ ...props, className: props.action === 'bubble' ? classNames.bubble : classNames.button });
  const { minWidth, maxWidth, defaultWidth } = ui.limits;
  const [available, setAvailable] = useState(maxWidth);
  const [narrow, setNarrow] = useState(false);
  const sidebar = ui.mode === 'sidebar';
  const floating = ui.mode === 'floating';
  const fullscreen = ui.mode === 'fullscreen';
  const modeKey = modesOf(modesProp).join(',');
  const modes = modeKey.split(',') as AssistantLayoutMode[];
  const layoutMenu = modes.includes('fullscreen') && modes.length > 1;
  const switchesDock = !layoutMenu && modes.includes('sidebar') && modes.includes('floating');
  const width = Math.min(ui.width, available);

  const floatingWidth = windowOptions.width ?? ui.width;
  const floatingHeight = windowOptions.height ?? 600;
  const right = windowOptions.right ?? 16;
  const bottom = windowOptions.bottom ?? 72;
  const { ref: shell, style: windowStyle, dragHandleProps, getResizeHandleProps } = useFloatingPanel<HTMLElement>({
    enabled: ui.open && floating,
    defaultRect: useCallback(() => {
      const height = Math.min(floatingHeight, window.innerHeight - 88);
      return { width: floatingWidth, height, x: window.innerWidth - floatingWidth - right, y: window.innerHeight - height - bottom };
    }, [floatingWidth, floatingHeight, right, bottom]),
    minWidth: windowOptions.minWidth ?? 320,
    minHeight: windowOptions.minHeight ?? 320,
    maxWidth: windowOptions.maxWidth ?? 960,
    maxHeight: windowOptions.maxHeight ?? 1200,
    storageKey: windowOptions.storageKey === null ? undefined : windowOptions.storageKey ?? 'glirastes:assistant-window:v1',
  });

  // On narrow screens the main area is hidden, so the panel takes its whole row.
  const fillsRow = sidebar && narrow && !ui.collapsed;
  const inset = ui.open && sidebar ? ui.collapsed ? railWidth : fillsRow ? 0 : width : 0;
  useEffect(() => {
    const measure = () => {
      const row = shell.current?.parentElement;
      const main = row?.querySelector<HTMLElement>(mainSelector);
      const rowWidth = row?.clientWidth || window.innerWidth;
      const siblings = row ? Array.from(row.children) : [];
      const leftWidth = main ? siblings.slice(0, siblings.indexOf(main)).reduce((sum, element) => sum + (getComputedStyle(element).position === 'fixed' ? 0 : element.getBoundingClientRect().width), 0) : 0;
      const remaining = rowWidth - leftWidth;
      setNarrow(remaining < narrowWidth);
      // The stored width stays as chosen, so a wider window gets it back.
      setAvailable(Math.max(minWidth, Math.min(maxWidth, remaining - minPageWidth)));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (shell.current?.parentElement) observer?.observe(shell.current.parentElement);
    const main = shell.current?.parentElement?.querySelector(mainSelector);
    if (main) observer?.observe(main);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [shell, mainSelector, narrowWidth, minPageWidth, minWidth, maxWidth]);
  useEffect(() => {
    if (insetProperty) document.documentElement.style.setProperty(insetProperty, `${inset}px`);
    const main = shell.current?.parentElement?.querySelector<HTMLElement>(mainSelector);
    // On phones the docked assistant uses the whole row rather than a tiny slice of it.
    if (main) main.hidden = Boolean(narrow && sidebar && ui.open && !ui.collapsed);
    return () => { if (insetProperty) document.documentElement.style.removeProperty(insetProperty); if (main) main.hidden = false; };
  }, [inset, narrow, sidebar, ui.open, ui.collapsed, shell, mainSelector, insetProperty]);

  const focusComposer = useCallback(() => {
    const composer = shell.current?.querySelector<HTMLElement>('[contenteditable="true"],[contenteditable=""],textarea');
    (composer ?? shell.current?.querySelector<HTMLElement>('button'))?.focus();
  }, [shell]);
  useEffect(() => {
    if (!ui.open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      if (!ui.collapsed || ui.mode === 'floating') focusComposer();
      else shell.current?.querySelector<HTMLElement>('button')?.focus();
    });
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, [ui.open, ui.collapsed, ui.mode, focusComposer, shell]);

  // Chat column in full screen: a column on wide screens, a drawer below 900 px.
  const narrowScreen = useMediaQuery(NARROW_SCREEN);
  const historyId = `assistant-history-${useId().replace(/:/g, '')}`;
  const historyRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [historyHidden, setHistoryHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const focusHistoryToggle = useCallback(() => {
    shell.current?.querySelector<HTMLElement>(`[aria-controls="${historyId}"], [data-action="history"]`)?.focus();
  }, [shell, historyId]);
  // Focus moves once the drawer is closed and the conversation is no longer inert.
  const focusAfterHistory = useRef<'toggle' | 'composer' | null>(null);
  const [, setFocusRequest] = useState(0);
  const closeDrawer = useCallback((refocus: 'toggle' | 'composer') => {
    focusAfterHistory.current = refocus;
    setDrawerOpen(false);
    setFocusRequest(n => n + 1);
  }, []);
  const pickedFromHistory = useCallback(() => closeDrawer('composer'), [closeDrawer]);
  const pane = !fullscreen || historyPane === false ? null
    : historyPane ?? (sessionsSupported ? <SessionSwitcher variant="list" onSelect={pickedFromHistory} /> : null);
  const hasPane = pane !== null && pane !== undefined;
  const drawer = hasPane && narrowScreen;
  const historyShown = hasPane && (narrowScreen ? drawerOpen : !historyHidden);
  // Leaving full screen or growing past the breakpoint closes the drawer.
  useEffect(() => { if (!fullscreen || !narrowScreen) setDrawerOpen(false); }, [fullscreen, narrowScreen]);
  useEffect(() => {
    if (!drawer || !drawerOpen) return;
    const frame = requestAnimationFrame(() => historyRef.current?.querySelector<HTMLElement>('button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [drawer, drawerOpen]);
  useInert(historyRef, !historyShown);
  useInert(frameRef, drawer && drawerOpen);
  useEffect(() => {
    const target = focusAfterHistory.current;
    if (!target || drawerOpen) return;
    focusAfterHistory.current = null;
    if (target === 'toggle') focusHistoryToggle();
    else focusComposer();
  });
  const activeChatTitle = chat?.sessions?.find(session => session.id === chat.activeSessionId)?.title || chat?.locale?.newChatLabel || labels.title;

  // A chat that keeps several conversations starts a new one by itself.
  const newChat = onNewChat ?? (sessionsSupported && chat?.createSession ? () => { void chat.createSession(); } : undefined);
  const shortcuts = useChatShortcuts({
    toggle: ui.toggleChat,
    // One layout: no layout shortcut.
    ...(modes.length > 1 ? { toggleLayout: () => {
      if (!ui.open) return;
      if (fullscreen) ui.restoreMode();
      else if (modes.includes('sidebar') && modes.includes('floating')) ui.setMode(sidebar ? 'floating' : 'sidebar');
    } } : {}),
    toggleCollapse: () => { if (ui.open && sidebar) ui.toggleCollapsed(); },
    ...(newChat ? { newChat: () => { ui.openChat(); newChat(); } } : {}),
    focusInput: () => { ui.openChat(); focusComposer(); requestAnimationFrame(focusComposer); },
  }, { shortcuts: shortcutOverrides, shouldIgnore: shouldIgnoreShortcut });

  // A layout outside `modes` falls back: full screen to the previous layout, otherwise the first listed one.
  const { mode, defaultMode, open, restoreMode, setMode, setDefaultMode } = ui;
  useEffect(() => {
    const allowed = modeKey.split(',') as AssistantLayoutMode[];
    const normal: AssistantLayoutMode[] = allowed.filter(m => m !== 'fullscreen');
    if (mode === 'fullscreen') {
      if (open && !allowed.includes('fullscreen')) restoreMode();
    } else if (open && !allowed.includes(mode)) {
      setMode(normal[0] ?? 'fullscreen');
    }
    if (normal.length && !normal.includes(defaultMode)) setDefaultMode(normal[0]!);
  }, [modeKey, mode, defaultMode, open, restoreMode, setMode, setDefaultMode]);

  // Full screen is a modal: the page is inert, Tab stays inside, Escape returns to the previous layout.
  useModalSurface(shell, { active: ui.open && fullscreen, onEscape: ui.restoreMode });

  const clear = onClear ?? chat?.clear;
  const fallbackLabels = DEFAULT_ASSISTANT_SHELL_LABELS;
  const layoutLabel = labels.layout ?? fallbackLabels.layout!;
  const modeEntries: Record<AssistantLayoutMode, { label: string; icon: ReactNode }> = {
    sidebar: { label: labels.sidebar ?? fallbackLabels.sidebar!, icon: icons.dock },
    floating: { label: labels.floating ?? fallbackLabels.floating!, icon: icons.detach },
    fullscreen: { label: labels.fullscreen ?? fallbackLabels.fullscreen!, icon: icons.fullscreen ?? DEFAULT_ASSISTANT_SHELL_ICONS.fullscreen },
  };
  const placement: CSSProperties = sidebar
    ? (fillsRow ? { flex: '1 1 0%', minWidth: 0 } : { width: ui.collapsed ? railWidth : width })
    : fullscreen
      ? { position: 'fixed', inset: 0, width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none' }
      // Before the window is measured it opens bottom right, as it will afterwards.
      : windowStyle ?? { position: 'fixed', width: floatingWidth, height: floatingHeight, right: `min(${right}px, max(0px, calc((100vw - 500px) / 2)))`, bottom };
  // A closed full screen reopens in `defaultMode`, so the bubble follows that layout.
  const bubble = floating || (fullscreen && !ui.open && ui.defaultMode === 'floating');

  return <>
    {bubble && showBubble && button({ action: 'bubble', label: labels.title, title: withShortcut(labels.title, shortcuts.toggle), pressed: ui.open, onClick: ui.toggleChat, children: icons.assistant })}
    <aside ref={shell} aria-label={labels.title} data-component="assistant-shell" data-assistant-shell data-mode={ui.mode}
      data-collapsed={(sidebar && ui.collapsed) || undefined} data-unstyled={chat?.unstyled || undefined}
      className={cx(classNames.root, sidebar ? classNames.sidebar : floating && classNames.floating)}
      style={{
        ...chat?.themeVars, ...style,
        display: ui.open ? 'flex' : 'none', flexDirection: hasPane ? 'row' : 'column', maxWidth: '100vw',
        ...(sidebar ? { position: 'relative', flexShrink: 0, height: '100%', maxHeight: '100%' } : { position: 'fixed', maxHeight: '100dvh' }),
        ...placement,
      }}>
      {sidebar && !ui.collapsed && !fillsRow && <SidebarResizeHandle label={labels.resize} width={width} min={minWidth} max={available}
        defaultWidth={defaultWidth} className={classNames.resizeHandle} onCommit={ui.setWidth} onPreview={value => {
          if (shell.current) shell.current.style.width = `${value}px`;
          if (insetProperty) document.documentElement.style.setProperty(insetProperty, `${value}px`);
        }} />}
      {floating && WINDOW_EDGES.map(edge => <div key={edge} aria-hidden data-component="assistant-shell-window-handle"
        className={classNames.windowHandle} style={edgeStyle(edge)} {...getResizeHandleProps(edge)} />)}

      {sidebar && ui.collapsed && <div data-element="rail" className={classNames.rail}>
        <button type="button" data-action="expand" className={classNames.railExpand} aria-label={labels.expand}
          title={withShortcut(labels.expand, shortcuts.toggleCollapse)} onClick={() => ui.setCollapsed(false)}>
          <span data-element="icon">{icons.assistant}</span><span data-element="rail-title" style={{ writingMode: 'vertical-rl' }}>{labels.title}</span>
        </button>
        {button({ action: 'close', label: labels.close, title: labels.close, onClick: ui.closeChat, children: icons.close })}
      </div>}
      {hasPane && <div ref={historyRef} data-element="history" data-drawer={drawer || undefined} id={historyId} hidden={!historyShown}
        style={{
          display: historyShown ? 'flex' : 'none', flexDirection: 'column', minHeight: 0, minWidth: 0, overflowY: 'auto', boxSizing: 'border-box',
          ...(drawer ? { position: 'absolute', top: 0, bottom: 0, left: 0, width: 'min(280px, calc(100% - 48px))', zIndex: 4 } : { flex: '0 0 260px', width: 260 }),
        }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !drawer || event.defaultPrevented) return;
          // The drawer owns this Escape; the next one leaves full screen.
          event.preventDefault();
          closeDrawer('toggle');
        }}>
        <div data-element="history-title" aria-hidden="true">{labels.history ?? DEFAULT_ASSISTANT_SHELL_LABELS.history}</div>
        {pane}
      </div>}
      {drawer && drawerOpen && <div data-element="history-backdrop" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, zIndex: 3 }} onClick={() => closeDrawer('toggle')} />}
      <div ref={frameRef} data-element="frame" style={{ display: sidebar && ui.collapsed ? 'none' : 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, ...(hasPane ? { minWidth: 0 } : {}) }}
        {...(fullscreen ? { role: 'dialog', 'aria-modal': true, 'aria-label': labels.title } : {})}>
        <header data-element="header" className={classNames.header}
          style={floating ? { cursor: 'grab', touchAction: 'none' } : undefined}
          {...(floating ? { tabIndex: 0, 'aria-label': labels.windowHeader, ...dragHandleProps } : {})}>
          {hasPane && button({
            action: 'history', label: historyShown ? labels.hideHistory ?? DEFAULT_ASSISTANT_SHELL_LABELS.hideHistory! : labels.showHistory ?? DEFAULT_ASSISTANT_SHELL_LABELS.showHistory!,
            title: historyShown ? labels.hideHistory ?? DEFAULT_ASSISTANT_SHELL_LABELS.hideHistory! : labels.showHistory ?? DEFAULT_ASSISTANT_SHELL_LABELS.showHistory!,
            expanded: historyShown, controls: historyId,
            onClick: () => { if (drawer) { if (drawerOpen) closeDrawer('toggle'); else setDrawerOpen(true); } else setHistoryHidden(hidden => !hidden); },
            children: icons.history ?? DEFAULT_ASSISTANT_SHELL_ICONS.history,
          })}
          {headerStart}
          <span data-element="icon">{icons.assistant}</span>
          {headerTitle ?? (hasPane && historyPane === undefined
            // The chat list is next to the conversation, so the header names the open chat.
            ? <span data-element="title" title={activeChatTitle}>{activeChatTitle}</span>
            : sessionsSupported
            // A chat that keeps several conversations lists them where the title would be.
            ? <SessionSwitcher fallbackTitle={labels.title} />
            : <span data-element="title">{labels.title}</span>)}
          {headerActions}
          {layoutMenu && <AssistantModeMenu modes={modes} current={ui.mode} label={layoutLabel} entries={modeEntries} onPick={ui.setMode}
            renderTrigger={({ expanded, controls, onClick }) => button({
              action: 'mode', label: `${layoutLabel}: ${modeEntries[ui.mode].label}`, title: withShortcut(layoutLabel, shortcuts.toggleLayout),
              expanded, controls, onClick, children: modeEntries[ui.mode].icon,
            })} />}
          {switchesDock && sidebar && button({ action: 'detach', label: labels.detach, title: withShortcut(labels.detach, shortcuts.toggleLayout), onClick: () => ui.setMode('floating'), children: icons.detach })}
          {showClearButton && clear && button({ action: 'clear', label: labels.clear, title: labels.clear, onClick: clear, children: icons.clear })}
          {sidebar
            ? button({ action: 'collapse', label: labels.collapse, title: withShortcut(labels.collapse, shortcuts.toggleCollapse), onClick: () => ui.setCollapsed(true), children: icons.collapse })
            : switchesDock && floating && button({ action: 'dock', label: labels.dock, title: withShortcut(labels.dock, shortcuts.toggleLayout), onClick: () => ui.setMode('sidebar'), children: icons.dock })}
          {button({ action: 'close', label: labels.close, title: withShortcut(labels.close, shortcuts.toggle), onClick: ui.closeChat, children: icons.close })}
        </header>
        <div data-element="body" className={classNames.body} style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 }}>
          {children}
        </div>
      </div>
    </aside>
  </>;
}
