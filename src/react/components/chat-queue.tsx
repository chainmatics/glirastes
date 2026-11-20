import { useMemo, useState } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { ChatQueueApi, ChatQueueProps, QueuedMessage } from '../types.js';

/**
 * The message queue of the chat (`queue` on `AiChatProvider`) for a headless
 * UI: what is queued, whether it is paused, and its actions.
 */
export function useChatQueue(): ChatQueueApi {
  const {
    queue, submit, submitWithResult, lastRejection, sendNow, removeQueued, editQueued, beginEdit, cancelEdit,
    clearQueue, resumeQueue, pauseQueue,
  } = useChatContext();
  return useMemo(() => ({
    enabled: queue.enabled,
    items: queue.items,
    paused: queue.paused,
    restoring: queue.restoring,
    editingId: queue.editingId,
    submit,
    submitWithResult,
    lastRejection,
    sendNow,
    removeQueued,
    editQueued,
    beginEdit,
    cancelEdit,
    clearQueue,
    resumeQueue,
    pauseQueue,
  }), [
    queue, submit, submitWithResult, lastRejection, sendNow, removeQueued, editQueued, beginEdit, cancelEdit,
    clearQueue, resumeQueue, pauseQueue,
  ]);
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

function QueueItem({ item, queue }: { item: QueuedMessage; queue: ChatQueueApi }) {
  const { locale } = useChatContext();
  // The edit lives in the queue (it holds the queue at this message); the typed text stays here.
  const editing = queue.editingId === item.id;
  const [draft, setDraft] = useState(item.text);
  const fileCount = item.files?.length ?? 0;
  return (
    <li data-element="item" data-queue-id={item.id} data-state={editing ? 'editing' : 'queued'}>
      {editing ? (
        <form
          data-element="edit"
          onSubmit={(event) => {
            event.preventDefault();
            queue.editQueued(item.id, draft);
          }}
        >
          <textarea
            value={draft}
            aria-label={locale.queueEditLabel}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
          />
          <button type="submit" data-action="save" disabled={draft.trim() === ''}>{locale.queueSaveLabel}</button>
          <button type="button" data-action="cancel" onClick={queue.cancelEdit}>{locale.queueCancelLabel}</button>
        </form>
      ) : (
        <>
          <span data-element="text">{item.text}</span>
          {fileCount > 0 && (
            <span data-element="files">{fill(locale.queueFilesLabel, { count: fileCount })}</span>
          )}
          <span data-element="actions">
            <button type="button" data-action="send-now" onClick={() => queue.sendNow(item.id)}>
              {locale.queueSendNowLabel}
            </button>
            <button type="button" data-action="edit" onClick={() => { setDraft(item.text); queue.beginEdit(item.id); }}>
              {locale.queueEditLabel}
            </button>
            <button type="button" data-action="remove" onClick={() => queue.removeQueued(item.id)}>
              {locale.queueRemoveLabel}
            </button>
          </span>
        </>
      )}
    </li>
  );
}

/**
 * Messages waiting to be sent (`queue.enabled`), with send now, edit, remove
 * and a paused notice with resume. Renders nothing while the queue is empty;
 * `children(queue)` renders it yourself. `AiChatPanel` shows it above the
 * composer; `components.ChatQueue` replaces it there (`null` hides it).
 */
export function ChatQueue({ className, children }: ChatQueueProps) {
  const queue = useChatQueue();
  const { classNames, locale, unstyled } = useChatContext();
  if (children) return <>{children(queue)}</>;
  if (!queue.enabled || queue.items.length === 0) return null;
  return (
    <div
      className={className ?? classNames.chatQueue}
      data-component="chat-queue"
      data-state={queue.paused ? 'paused' : 'waiting'}
      data-unstyled={unstyled || undefined}
    >
      <p data-element="title">{fill(locale.queueTitle, { count: queue.items.length })}</p>
      {queue.paused && (
        <div data-element="paused" role="status">
          <span>{locale.queuePausedLabel}</span>
          <button type="button" data-action="resume" onClick={queue.resumeQueue}>
            {locale.queueResumeLabel}
          </button>
        </div>
      )}
      <ol data-element="items">
        {queue.items.map((item) => <QueueItem key={item.id} item={item} queue={queue} />)}
      </ol>
    </div>
  );
}
