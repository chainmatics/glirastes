import { useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { ChatWindowVisibilityContext } from './chat-window-visibility.js';

export interface SessionSwitcherProps {
  /** Temporarily lock session controls, e.g. while the app records a voice draft. */
  disabled?: boolean;
  /** Shown when no sessions exist yet. */
  fallbackTitle?: string;
  /** Format the per-row subtitle. Default: `updatedAt` or `createdAt` as locale date. */
  formatTimestamp?: (value: string | number | undefined) => string;
  className?: string;
  /** `dropdown` (default): the compact header switcher. `list`: an always visible list for a side column. */
  variant?: 'dropdown' | 'list';
  /** After a chat was picked or created, e.g. to close a drawer and focus the composer. */
  onSelect?: () => void;
  /** Replace the "+" of new chat and the rename and delete icons; unset keys keep the defaults. */
  icons?: Partial<SessionSwitcherIcons>;
}

/**
 * Icons of the session switcher. They are decorative: the buttons keep their
 * names from the chat locale (`newChatLabel`, `renameSessionAriaLabel`,
 * `deleteSessionAriaLabel`).
 */
export interface SessionSwitcherIcons {
  /** Inside `[data-element="plus"]` of the new-chat button; `false` drops that element. Default: the text `+`. */
  newChat: ReactNode;
  rename: ReactNode;
  delete: ReactNode;
}

/** State of the lock on changing the conversation, for an app's own session controls. */
export interface SessionLockState {
  /**
   * Panel visibility: false while the surrounding `ChatWindow` (as in
   * `FloatingChatUI`) is closed or collapsed. True outside a `ChatWindow`,
   * also in `AssistantShell` (use `useAssistantLayout().open` there).
   */
  visible: boolean;
  /**
   * A reply streams, a UI action outcome is awaited or a session operation
   * runs: `isSessionChangeBlocked` of the chat context, or `isLoading` from
   * a context that does not set it.
   */
  sessionChangeBlocked: boolean;
  /** `!visible || sessionChangeBlocked`: when the built-in `SessionSwitcher` disables its controls. */
  locked: boolean;
}

/**
 * Whether switching, creating, renaming or deleting a chat is allowed right
 * now, the same rule the built-in `SessionSwitcher` follows. Needs an
 * `AiChatProvider` (or a `ChatContext`) above it.
 */
export function useSessionLock(): SessionLockState {
  const { isSessionChangeBlocked, isLoading } = useChatContext();
  const visible = useContext(ChatWindowVisibilityContext);
  const sessionChangeBlocked = isSessionChangeBlocked ?? isLoading;
  return { visible, sessionChangeBlocked, locked: !visible || sessionChangeBlocked };
}

function defaultFormatTimestamp(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Compact dropdown that lists all chat sessions, lets the user switch
 * between them, create new ones, and delete existing ones. Reads
 * everything from `useChatContext()` — requires an `<AiChatProvider>`
 * ancestor whose `session` config exposes `list`, `create`, and `remove`.
 */
export function SessionSwitcher({
  disabled = false,
  fallbackTitle,
  formatTimestamp = defaultFormatTimestamp,
  className,
  variant = 'dropdown',
  onSelect,
  icons,
}: SessionSwitcherProps = {}) {
  const {
    sessions,
    activeSessionId,
    sessionsSupported,
    isSessionsLoading,
    switchSession,
    createSession,
    removeSession,
    renameSession,
    locale,
  } = useChatContext();
  const blocked = useSessionLock().locked || disabled;
  const newChatIcon = icons?.newChat ?? DEFAULT_SESSION_SWITCHER_ICONS.newChat;
  const renameIcon = icons?.rename ?? DEFAULT_SESSION_SWITCHER_ICONS.rename;
  const deleteIcon = icons?.delete ?? DEFAULT_SESSION_SWITCHER_ICONS.delete;
  const plus = newChatIcon === false ? null : <span data-element="plus" aria-hidden="true">{newChatIcon}</span>;
  const resolvedFallback = fallbackTitle ?? locale.newChatLabel;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const beginEdit = useCallback(
    (e: React.MouseEvent, id: string, title: string) => {
      e.stopPropagation();
      setEditingId(id);
      setEditDraft(title);
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft('');
  }, []);

  const commitEdit = useCallback(async () => {
    const id = editingId;
    const next = editDraft.trim();
    setEditingId(null);
    setEditDraft('');
    if (!id) return;
    const current = sessions.find((s) => s.id === id)?.title ?? '';
    if (!next || next === current) return;
    await renameSession(id, next);
  }, [editingId, editDraft, renameSession, sessions]);
  const [open, setOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!blocked) return;
    setOpen(false);
    setPendingDeleteId(null);
    setEditingId(null);
  }, [blocked]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (rootRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const onNew = useCallback(async () => {
    if (blocked) return;
    setOpen(false);
    await createSession();
    onSelect?.();
  }, [createSession, blocked, onSelect]);

  const onPick = useCallback(
    async (id: string) => {
      if (blocked) return;
      setOpen(false);
      await switchSession(id);
      onSelect?.();
    },
    [switchSession, blocked, onSelect],
  );

  const onDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setPendingDeleteId(id);
    },
    [],
  );

  const confirmDelete = useCallback(async () => {
    if (blocked) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    if (!id) return;
    await removeSession(id);
  }, [pendingDeleteId, removeSession, blocked]);

  const cancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  const idBase = `session-switcher-${useId().replace(/:/g, '')}`;
  const listRef = useRef<HTMLElement>(null);

  if (!sessionsSupported) {
    return variant === 'list' ? null : <strong data-element="title">{resolvedFallback}</strong>;
  }

  const sorted = [...sessions].sort((a, b) => {
    const av = Number(new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()) || 0;
    const bv = Number(new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()) || 0;
    return bv - av;
  });
  const current = sorted.find((s) => s.id === activeSessionId);
  const currentTitle = current?.title ?? resolvedFallback;
  const pendingDeleteTitle = sessions.find(
    (session) => session.id === pendingDeleteId,
  )?.title;

  const confirmDialog = (
    <ConfirmDialog
      open={pendingDeleteId !== null && !blocked}
      title={locale.confirmDeleteSessionPrompt}
      message={
        pendingDeleteTitle
          ? locale.sessionArchiveMessage.replace(
            '{title}',
            () => pendingDeleteTitle,
          )
          : undefined
      }
      confirmLabel={locale.deleteSessionAriaLabel}
      cancelLabel={locale.cancelButton}
      destructive
      onConfirm={() => void confirmDelete()}
      onCancel={cancelDelete}
    />
  );

  if (variant === 'list') {
    // Arrow keys move between "new chat" and the chats; edit and delete are reached with Tab.
    const onListKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      // Keys from the portaled delete dialog bubble here through React; they are not ours.
      if (!event.currentTarget.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      const stops = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-element="new-session"], [data-element="row-main"]',
      ) ?? []).filter((button) => !button.disabled);
      if (stops.length === 0) return;
      event.preventDefault();
      const index = stops.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? stops.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % stops.length
            : (index - 1 + stops.length) % stops.length;
      stops[next]?.focus();
    };
    const labelId = `${idBase}-label`;
    return (
      <nav
        ref={listRef}
        className={className}
        data-component="session-switcher"
        data-variant="list"
        aria-label={locale.chatHistoryLabel ?? 'Chats'}
        onKeyDown={onListKeyDown}
      >
        <button
          type="button"
          data-element="new-session"
          onClick={() => void onNew()}
          disabled={blocked || isSessionsLoading}
        >
          {plus}
          {locale.newChatLabel}
        </button>
        <div data-element="history-label" id={labelId}>
          {locale.recentChatsLabel ?? 'Recent chats'}
        </div>
        <ul data-element="session-list" aria-labelledby={labelId}>
          {sorted.length === 0 ? (
            <li data-element="empty">
              {isSessionsLoading ? locale.sessionsLoadingLabel : locale.noSessionsLabel}
            </li>
          ) : (
            sorted.map((s, index) => {
              const isActive = s.id === activeSessionId;
              const isEditing = editingId === s.id;
              const title = s.title || locale.untitledSessionLabel;
              const rowId = `${idBase}-row-${index}`;
              return (
                <li
                  key={s.id}
                  data-element="session-row"
                  data-active={isActive || undefined}
                  data-editing={isEditing || undefined}
                >
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      data-element="row-title-input"
                      aria-label={locale.renameSessionAriaLabel}
                      value={editDraft}
                      placeholder={locale.renameSessionPlaceholder}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitEdit();
                        } else if (e.key === 'Escape') {
                          // The rename owns this Escape, not a surrounding drawer or full screen.
                          e.preventDefault();
                          e.stopPropagation();
                          cancelEdit();
                        }
                      }}
                      onBlur={() => void commitEdit()}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        data-element="row-main"
                        aria-current={isActive ? 'page' : undefined}
                        title={title}
                        disabled={blocked}
                        onClick={() => void onPick(s.id)}
                      >
                        <span data-element="row-title" id={rowId}>{title}</span>
                      </button>
                      <button
                        type="button"
                        data-element="row-edit"
                        aria-label={locale.renameSessionAriaLabel}
                        aria-describedby={rowId}
                        disabled={blocked}
                        onClick={(e) => beginEdit(e, s.id, s.title || '')}
                      >
                        {renameIcon}
                      </button>
                      <button
                        type="button"
                        data-element="row-delete"
                        aria-label={locale.deleteSessionAriaLabel}
                        aria-describedby={rowId}
                        disabled={blocked}
                        onClick={(e) => onDelete(e, s.id)}
                      >
                        {deleteIcon}
                      </button>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
        {confirmDialog}
      </nav>
    );
  }

  return (
    <div
      ref={rootRef}
      className={className}
      data-component="session-switcher"
      data-open={open || undefined}
    >
      <button
        type="button"
        data-element="trigger"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={blocked}
      >
        <span data-element="trigger-title">{currentTitle}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && !blocked && (
        <div
          data-element="popover"
          role="listbox"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            data-element="new-session"
            onClick={onNew}
            disabled={isSessionsLoading}
          >
            {plus}
            {locale.newChatLabel}
          </button>

          <div data-element="session-list">
            {sorted.length === 0 ? (
              <div data-element="empty">
                {isSessionsLoading ? locale.sessionsLoadingLabel : locale.noSessionsLabel}
              </div>
            ) : (
              sorted.map((s) => {
                const isActive = s.id === activeSessionId;
                const ts = formatTimestamp(s.updatedAt ?? s.createdAt);
                const isEditing = editingId === s.id;
                return (
                  <div
                    key={s.id}
                    role="option"
                    aria-selected={isActive}
                    data-element="session-row"
                    data-active={isActive || undefined}
                    data-editing={isEditing || undefined}
                    onClick={() => {
                      if (isEditing) return;
                      void onPick(s.id);
                    }}
                  >
                    <div data-element="row-main">
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          data-element="row-title-input"
                          value={editDraft}
                          placeholder={locale.renameSessionPlaceholder}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitEdit();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelEdit();
                            }
                          }}
                          onBlur={() => void commitEdit()}
                        />
                      ) : (
                        <div data-element="row-title">
                          {s.title || locale.untitledSessionLabel}
                        </div>
                      )}
                      {ts && !isEditing && (
                        <div data-element="row-subtitle">{ts}</div>
                      )}
                    </div>
                    {!isEditing && (
                      <>
                        <button
                          type="button"
                          data-element="row-edit"
                          aria-label={locale.renameSessionAriaLabel}
                          title={locale.renameSessionAriaLabel}
                          onClick={(e) => beginEdit(e, s.id, s.title || '')}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {renameIcon}
                        </button>
                        <button
                          type="button"
                          data-element="row-delete"
                          aria-label={locale.deleteSessionAriaLabel}
                          title={locale.deleteSessionAriaLabel}
                          onClick={(e) => void onDelete(e, s.id)}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {deleteIcon}
                        </button>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}

const EDIT_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const DELETE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

/** The shipped icons: the text `+`, a pencil and a bin. */
export const DEFAULT_SESSION_SWITCHER_ICONS: SessionSwitcherIcons = Object.freeze({
  newChat: '+',
  rename: EDIT_ICON,
  delete: DELETE_ICON,
});
