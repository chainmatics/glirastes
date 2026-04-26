'use client';

import '../styles.css';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { AiTriggerButton } from './ai-trigger-button.js';
import { ChatWindow } from './chat-window.js';
import { AiChatPanel } from './ai-chat-panel.js';
import { SessionSwitcher } from './session-switcher.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { useChatContext } from '../provider/chat-context.js';
import { useKeyboardShortcut } from '../hooks/use-keyboard-shortcut.js';
import type { ChatDimension, ChatSize } from '../types.js';

// ---------------------------------------------------------------------------
// Size resolution
// ---------------------------------------------------------------------------

const SIZE_PRESETS: Record<string, { width: number; height: number }> = {
  sm: { width: 360, height: 560 },
  md: { width: 420, height: 640 },
  lg: { width: 520, height: 720 },
  xl: { width: 640, height: 820 },
};

/**
 * Parse a single CSS length into a pixel count. Viewport-relative units
 * are resolved against the supplied `vw`/`vh` values (typically from
 * `window.innerWidth/innerHeight`). Unknown units fall back to the
 * default.
 */
function parseDimension(
  value: ChatDimension,
  axis: 'w' | 'h',
  vw: number,
  vh: number,
  fallback: number,
): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  const match = trimmed.match(/^(-?[\d.]+)(px|vw|vh|%|em|rem)?$/);
  if (!match) return fallback;
  const n = parseFloat(match[1]);
  const unit = (match[2] ?? 'px') as string;
  switch (unit) {
    case 'vw':
      return (vw * n) / 100;
    case 'vh':
      return (vh * n) / 100;
    case '%':
      // `%` in this context means percentage of the relevant viewport axis.
      return ((axis === 'w' ? vw : vh) * n) / 100;
    case 'em':
    case 'rem':
      return n * 16;
    case 'px':
    default:
      return n;
  }
}

function resolveSize(
  size: ChatSize | undefined,
  vw: number,
  vh: number,
): { width: number; height: number; fullscreen: boolean } {
  if (size === undefined) {
    return { ...SIZE_PRESETS.md, fullscreen: false };
  }
  if (size === 'full') {
    return { width: vw, height: vh, fullscreen: true };
  }
  if (typeof size === 'string') {
    const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS.md;
    return { ...preset, fullscreen: false };
  }
  return {
    width: parseDimension(size.width, 'w', vw, vh, SIZE_PRESETS.md.width),
    height: parseDimension(size.height, 'h', vw, vh, SIZE_PRESETS.md.height),
    fullscreen: false,
  };
}

/**
 * Track `window.innerWidth`/`innerHeight` with a render on resize so
 * viewport-relative sizes (`40vw`, `70vh`, `'full'`) re-resolve as the
 * browser window changes shape.
 */
function useViewportSize(): { vw: number; vh: number } {
  const [size, setSize] = useState(() => ({
    vw: typeof window !== 'undefined' ? window.innerWidth : 1024,
    vh: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setSize({ vw: window.innerWidth, vh: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export interface FloatingChatUIProps {
  /** Window header title. Default: "AI Assistant" */
  title?: string;
  /**
   * Controlled open state. When provided, the component becomes a
   * controlled component and `defaultOpen` is ignored. Pair with
   * `onOpenChange` to drive the window from external state (e.g. a
   * trigger button elsewhere in the page).
   */
  open?: boolean;
  /**
   * Called whenever the window wants to open or close itself — from the
   * trigger pill, the close button, the Escape key, or the keyboard
   * shortcut. Required to fully control `open`.
   */
  onOpenChange?: (open: boolean) => void;
  /** Whether the window starts open. Default: false */
  defaultOpen?: boolean;
  /** Window is draggable by its header. Default: true */
  draggable?: boolean;
  /** Window is resizable. Default: true */
  resizable?: boolean;
  /**
   * Window size — a preset (`'sm' | 'md' | 'lg' | 'xl' | 'full'`) or an
   * explicit `{ width, height }` pair. Dimensions accept numbers (px)
   * or CSS strings like `'40vw'`, `'70vh'`, `'32rem'` — viewport units
   * are re-resolved on window resize.
   *
   * Default: `'md'` (420×640).
   *
   * ```tsx
   * <LangGraphAiChat size="lg" />
   * <LangGraphAiChat size={{ width: '40vw', height: '70vh' }} />
   * ```
   */
  size?: ChatSize;
  /**
   * Hide the floating trigger pill while the chat window is open.
   * Default: true. Set to false to keep both visible simultaneously.
   */
  hideTriggerWhenOpen?: boolean;
  /**
   * Global keyboard shortcut that toggles the window. Use `false` to
   * disable. Defaults to `'mod+i'` (⌘I on Mac, Ctrl+I elsewhere).
   */
  shortcut?: string | false;
  /** Show the built-in clear / trash button in the header. Default: true. */
  showClearButton?: boolean;
  /** Ask for confirmation before clearing. Default: true. */
  confirmClear?: boolean;
  /**
   * Render the built-in session switcher in the header. Default: auto —
   * shown when the provider's `session.list/create/remove` are all defined.
   */
  showSessionSwitcher?: boolean | 'auto';
  /** Replace the default header actions with a custom node. */
  headerActions?: ReactNode;
  /**
   * Replace the sparkle icon on the floating trigger pill with a custom
   * node — typically a small logo or branded SVG. Default: built-in
   * sparkle.
   *
   * ```tsx
   * <LangGraphAiChat triggerIcon={<img src="/logo.svg" width={16} height={16} />} />
   * ```
   */
  triggerIcon?: ReactNode;
  /**
   * Show the mic button on the trigger pill. When unset, the mic auto-
   * shows only if `voice.enabled` is true on the provider config. Set
   * to `false` to force-hide (renders a single-icon trigger) or `true`
   * to force-show.
   */
  showMic?: boolean;
  /**
   * Ephemeral assistant greeting shown only while the current session
   * has no messages. Not persisted — forwarded to `AiChatPanel`. See
   * `AiChatPanelProps.welcomeMessage`.
   */
  welcomeMessage?: string;
}

/**
 * Floating chat UI: a fixed trigger pill + a draggable, resizable chat
 * window that opens when the pill is clicked. Must be mounted inside an
 * `<AiChatProvider>`.
 */
export function FloatingChatUI({
  title,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  draggable = true,
  resizable = true,
  size,
  hideTriggerWhenOpen = true,
  shortcut = 'mod+i',
  showClearButton = true,
  confirmClear = true,
  showSessionSwitcher = 'auto',
  headerActions,
  triggerIcon,
  showMic,
  welcomeMessage,
}: FloatingChatUIProps = {}) {
  const { classNames, locale, voice, sessionsSupported } = useChatContext();
  const { vw, vh } = useViewportSize();
  const resolvedSize = resolveSize(size, vw, vh);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const resolved =
        typeof next === 'function'
          ? (next as (prev: boolean) => boolean)(open)
          : next;
      if (!isControlled) setUncontrolledOpen(resolved);
      onOpenChange?.(resolved);
    },
    [isControlled, onOpenChange, open],
  );
  const noop = useCallback(() => {}, []);

  useKeyboardShortcut(shortcut, () => setOpen((v) => !v));
  useKeyboardShortcut('escape', () => setOpen(false), { enabled: open });

  // Was the title prop explicitly set by the consumer? (vs using the
  // locale fallback.) Drives the "title + switcher coexist" branch.
  const hasConsumerTitle = title !== undefined;
  const resolvedTitle = title ?? locale.chatTitle;

  const switcherIsOn =
    showSessionSwitcher === true ||
    (showSessionSwitcher === 'auto' && sessionsSupported);

  // When both a consumer title AND a session switcher exist, the title
  // holds the main header slot and the switcher moves into the actions
  // strip so they don't fight for the same real estate.
  const renderSwitcherInActions = hasConsumerTitle && switcherIsOn;

  // Auto-hide the mic when the consumer didn't opt into voice. Explicit
  // `showMic` prop always wins.
  const effectiveShowMic =
    showMic ?? Boolean(voice?.enabled);

  return (
    <>
      {(!hideTriggerWhenOpen || !open) && (
        <AiTriggerButton
          onClickChat={() => setOpen(true)}
          onClickMic={noop}
          showMic={effectiveShowMic}
          icon={triggerIcon}
          className={classNames.trigger}
          buttonClassName={classNames.triggerPill}
          ariaLabel={locale.triggerAriaLabel}
          micAriaLabel={locale.micAriaLabel}
          stopAriaLabel={locale.stopRecordingAriaLabel}
          cancelAriaLabel={locale.cancelRecordingAriaLabel}
        />
      )}
      <ChatWindow
        open={open}
        onOpenChange={setOpen}
        title={resolvedTitle}
        closeChatAriaLabel={locale.closeChatAriaLabel}
        draggable={draggable && !resolvedSize.fullscreen}
        resizable={resizable && !resolvedSize.fullscreen}
        width={resolvedSize.width}
        height={resolvedSize.height}
        className={classNames.window}
        headerClassName={classNames.windowHeader}
        bodyClassName={classNames.windowBody}
        headerTitle={
          renderSwitcherInActions ? (
            <strong data-element="title">{resolvedTitle}</strong>
          ) : (
            <FloatingHeaderTitle
              fallback={resolvedTitle}
              showSessionSwitcher={showSessionSwitcher}
              className={classNames.switcher}
            />
          )
        }
        headerActions={
          headerActions ?? (
            <>
              {renderSwitcherInActions && (
                <SessionSwitcher className={classNames.switcher} />
              )}
              <FloatingHeaderActions
                showClearButton={showClearButton}
                confirmClear={confirmClear}
              />
            </>
          )
        }
      >
        <AiChatPanel welcomeMessage={welcomeMessage} />
      </ChatWindow>
    </>
  );
}

// ---------------------------------------------------------------------------
// Header sub-components — must live inside the provider so they can read
// the chat context (clear(), sessions, etc).
// ---------------------------------------------------------------------------

function FloatingHeaderTitle({
  fallback,
  showSessionSwitcher,
  className,
}: {
  fallback: string;
  showSessionSwitcher: boolean | 'auto';
  className?: string;
}) {
  const ctx = useChatContext();
  const shouldShow =
    showSessionSwitcher === true ||
    (showSessionSwitcher === 'auto' && ctx.sessionsSupported);

  if (!shouldShow) {
    return <strong data-element="title">{fallback}</strong>;
  }
  return <SessionSwitcher fallbackTitle={fallback} className={className} />;
}

function FloatingHeaderActions({
  showClearButton,
  confirmClear,
}: {
  showClearButton: boolean;
  confirmClear: boolean;
}) {
  const { clear, messages, locale } = useChatContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!showClearButton) return null;
  const disabled = messages.length === 0;

  const onClick = () => {
    if (disabled) return;
    if (confirmClear) {
      setConfirmOpen(true);
      return;
    }
    clear();
  };

  return (
    <>
    <button
      type="button"
      onClick={onClick}
      data-action="clear"
      aria-label={locale.clearChatAriaLabel}
      title={locale.clearChatAriaLabel}
      disabled={disabled}
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
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
    <ConfirmDialog
      open={confirmOpen}
      title={locale.confirmClearPrompt}
      confirmLabel={locale.clearButton}
      cancelLabel={locale.cancelButton}
      destructive
      onConfirm={() => {
        setConfirmOpen(false);
        clear();
      }}
      onCancel={() => setConfirmOpen(false)}
    />
    </>
  );
}
