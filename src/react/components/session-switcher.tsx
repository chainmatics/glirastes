import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { ConfirmDialog } from './confirm-dialog.js';

export interface SessionSwitcherProps {
  /** Shown when no sessions exist yet. */
  fallbackTitle?: string;
  /** Format the per-row subtitle. Default: `updatedAt` or `createdAt` as locale date. */
  formatTimestamp?: (value: string | number | undefined) => string;
  className?: string;
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
  fallbackTitle,
  formatTimestamp = defaultFormatTimestamp,
  className,
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
    setOpen(false);
    await createSession({ title: locale.newChatLabel });
  }, [createSession, locale.newChatLabel]);

  const onPick = useCallback(
    async (id: string) => {
      setOpen(false);
      if (id === activeSessionId) return;
      await switchSession(id);
    },
    [switchSession, activeSessionId],
  );

  const onDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setPendingDeleteId(id);
    },
    [],
  );

  const confirmDelete = useCallback(async () => {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    if (!id) return;
    await removeSession(id);
  }, [pendingDeleteId, removeSession]);

  const cancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  if (!sessionsSupported) {
    return <strong data-element="title">{resolvedFallback}</strong>;
  }

  const sorted = [...sessions].sort((a, b) => {
    const av = Number(new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()) || 0;
    const bv = Number(new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()) || 0;
    return bv - av;
  });
  const current = sorted.find((s) => s.id === activeSessionId);
  const currentTitle = current?.title ?? resolvedFallback;

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

      {open && (
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
            <span data-element="plus" aria-hidden="true">+</span>
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
                        <div data-element="row-title">{s.title || 'Untitled'}</div>
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
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          data-element="row-delete"
                          aria-label={locale.deleteSessionAriaLabel}
                          title={locale.deleteSessionAriaLabel}
                          onClick={(e) => void onDelete(e, s.id)}
                          onMouseDown={(e) => e.stopPropagation()}
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
                          </svg>
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

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={locale.confirmDeleteSessionPrompt}
        message={
          sessions.find((s) => s.id === pendingDeleteId)?.title
            ? `"${sessions.find((s) => s.id === pendingDeleteId)?.title}" will be archived.`
            : undefined
        }
        confirmLabel={locale.deleteSessionAriaLabel}
        cancelLabel={locale.cancelButton}
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={cancelDelete}
      />
    </div>
  );
}
