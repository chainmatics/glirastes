# Chat message queue

With `queue.enabled` the chat composer is never locked by a running turn.
A message sent while a run is busy, or while an approval is open, waits in a
queue and is sent once the chat is idle, one run at a time. Glirastes provides
the state and the behaviour; the app renders the queue itself or uses the
default `ChatQueue` component.

The queue is off by default. Without `queue`, or with `enabled: false`, the
chat behaves exactly as before: the composers lock while loading, `send`
refuses while an approval is open, and the markup is unchanged.

Everything stays in the browser. Queued texts, `onQueueChange` events and the
storage adapter are local; nothing goes to the Platform.

## Contents

- Options and defaults
- What happens when
- Context API and `useChatQueue`
- `ChatQueue` component
- Persistence adapter
- Limits

## Options and defaults

```tsx
<AiChatProvider transport={transport} queue={{ enabled: true }}>
  <AiChatPanel />
</AiChatProvider>
```

`<glirastes-chat>` takes the same object in `config.queue`.

| Option | Default | Why |
| --- | --- | --- |
| `enabled` | `false` | Opt-in: an app that does not set it sees no change. |
| `autoFlush` | `true` | Send the next message once idle (FIFO, one run at a time, wait for idle again before the next). `false` keeps them until `sendNow`. |
| `sendNowBehavior` | `'next'` | Non-destructive: `sendNow` moves the message to the head; it goes as soon as the chat is idle, also when the queue is paused or `autoFlush` is off. `'abort'` stops the running run first (`stop()`); that stop does not pause the queue. |
| `maxSize` | `10` | Every queued message is a model call nobody watches start. A full queue refuses the message (`'rejected'`, the composer keeps the draft). `Infinity` or `null` lifts the limit. |
| `pauseOn` | `['error', 'aborted', 'safety-stop', 'truncation']` | A run that ended badly should not be followed by unattended runs. `truncation` covers a run that left a continue prompt: a flush would discard it. |
| `sendNowDuringApproval` | `'refuse'` | The chat never treats a typed message as an approval decision. `'refuse'`: `sendNow` returns false and shows the approval hint. `'reject-approval'`: the open approvals are rejected through the normal reject path, then the message is sent. |
| `storage` | none | Optional persistence per conversation (below). |
| `onQueueChange(event)` | none | `{ queued, paused, reason }` after every change. A throw from it is ignored. |

`reason` is one of `added`, `removed`, `edited`, `reordered` (`sendNow` moved
a message to the head), `sent`, `cleared`, `paused`, `resumed`, `restored`.

## What happens when

"Idle" for sending a queued message means all of: no request running, no UI
action of the last result still running or waiting for its outcome, no
page-load continuation running, no open approval (read from the message parts,
also in the render before the approval card exists), no answered approval the
transport is about to send on by itself, no open clarification, no open
command form, the conversation loaded and not being switched, and the queue
not paused (except for the one `sendNow` message).

| Situation | With the queue |
| --- | --- |
| Send while a run is loading | Queued (`submit` returns `'queued'`, `send` true, the composer clears its draft). |
| Send while idle and the queue is empty | Sent at once (`'sent'`). |
| Send while idle and messages are queued | Queued behind them (order is kept). |
| Send while an approval is open | Queued; the approval hint (`approvalReminder`, text `queueApprovalWaitingHint`) shows for the first queued message. Held until every approval is decided. |
| Approval decided, transport continues by itself | Held until that continuation ended. |
| Approval decided, transport does not continue (`autoResumeOnApproval: false`) | Sent 1.5 s after the answer: the queue never waits forever. |
| `sendNow` while an approval is open | `'refuse'` (default): false and the hint. `'reject-approval'`: rejects them, then sends. |
| Run ends with an error | Paused until `resumeQueue()` (`pauseOn`). |
| User stops the run (`stop()`) | Paused (`'aborted'`). |
| `sendNow` with `'abort'` | Stops the run, sends the message; not paused. |
| Later turns after a stopped or failed one | The stopped turn keeps what it showed (text, the log with its calls as stopped) and its recorded outcome (`useTurnOutcome`, `reason` `stopped`, `send-now` or `request-failed`), also when it ended before an assistant message existed and after a reload. Its notice stays at it, right after the question when no answer had arrived (`activityLog.noticeScope`, `docs/concepts.md`, message layout). |
| Safety stop (`pipelineState.status: 'safety-stop'`) | Paused. |
| Truncation (continue banner) | Paused; resuming sends the next message, which replaces the continue prompt. |
| Clarification open after a run | Held: a queued text is never turned into a clarification answer by itself. A message the user sends now (or the card's answer) answers it at once, ahead of the queue. |
| A queued `/` command that needs arguments | Its form opens when it is sent; the queue waits for the form. |
| A command form is open | A message sent meanwhile is queued; queued messages wait until the form is run or cancelled. A command or entity action is refused while the chat is busy. |
| UI actions of the last result still running | Held until they finished. |
| Conversation not loaded yet, or a session change in progress | `submit` refuses (`'rejected'`), as `send` did before; the composer is locked (`canCompose` false). |
| `clear()`, switching, creating or removing the active conversation, the host changing `session.activeId` | The in-memory queue is emptied (`'cleared'`); with `storage` the new conversation's queue is loaded. |
| A turn of the left chat ends after switching (host-owned `session.activeId`; `switchSession`, `createSession` and `removeSession` refuse while a request runs) | Nothing queued before the switch is sent: that queue was emptied. The transport is shared, so a message queued in the new chat waits until that request ended, then goes out once, into the new chat. The ended turn's outcome is not booked on the new chat. |
| Back in the first chat | Its queue is empty; with `storage` it comes back paused (`'restored'`) and is sent only after `resumeQueue()` or `sendNow`, into that chat. |
| Language or locale change | The queue is kept (texts are the user's own and are processed when sent). |
| Provider unmounts | The queue is dropped. |
| `onBeforeSend` throws for a queued message | The queue pauses; the message stays. |
| A queued message with files edited into a direct command | `editQueued` refuses it (a command cannot carry files); should one reach the head anyway, the queue pauses and keeps it. |
| A queued message with files when attachments were turned off meanwhile | Not sent; the queue pauses and keeps it. |
| `clear()` or `clearQueue()` while the stored queue still loads | The late load is dropped and an empty queue is saved. |
| An emptied queue | No longer paused. |
| A message open in an editor (`beginEdit`) | The queue holds when it reaches it: neither it nor a later message is sent until `editQueued` (saves and ends the edit), `cancelEdit` or removing it. Messages before it still go. `sendNow` refuses it while open. |
| `queue.storage` still reading the conversation's queue (`queue.restoring`) | Nothing is sent; a message sent meanwhile is queued behind the stored ones. |
| Conversation left before its stored queue was read | What was queued meanwhile is added to that conversation's stored queue (read, appended, saved); it comes back, paused, on return. |

Processing happens when a queued message is sent, through the same path as a
typed one: `/` commands, mention serialization, `onBeforeSend` and the
clarification check. The mentions active when the message was queued (or the
`mentions` passed to `send`) are captured with it, and the active mentions are
cleared as a normal send does. Files are validated as on `send`: refused while
attachments are off, and refused with a direct command.

## Context API and `useChatQueue`

`useChatContext()` adds:

| Member | Effect |
| --- | --- |
| `send(text, options?)` | Unchanged signature; with the queue true when sent or queued, false when refused. |
| `submit(text, options?)` | `'sent'`, `'queued'` or `'rejected'`; also without the queue (`'sent'`/`'rejected'`). |
| `submitWithResult(text, options?)` | `submit` with the reason: `{ status: 'sent' \| 'queued' }` or `{ status: 'rejected', reason }` (below). |
| `lastRejection` | `{ reason, at }` of the latest refused `send`/`submit` (also from the built-in composers), else null; null again after an accepted message, `clear()` or a conversation change. |
| `queue` | `{ enabled, items, paused, restoring, editingId }`. |
| `canCompose` | Whether a composer takes input: without the queue `!isLoading`; with it false only while the conversation loads or changes. |
| `sendNow(id)`, `removeQueued(id)`, `editQueued(id, text)` | `boolean`: false for an unknown id (or an empty text). |
| `beginEdit(id)`, `cancelEdit()` | Open / close the editor of a queued message (one at a time); while open, the queue holds at it. Call `beginEdit` when your UI opens an editor, so a run that ends meanwhile does not send the old text. |
| `clearQueue()`, `resumeQueue()`, `pauseQueue()` | |

### Why a message was refused

`submit` keeps its three strings. The reason is additive, with and without
the queue:

| `reason` | When |
| --- | --- |
| `session` | The conversation is not loaded yet or is changing (`canCompose` false). |
| `approval-open` | An approval waits; only without the queue (with it the message is queued). |
| `attachments-off` | `files` while attachments are off. |
| `files-with-command` | `files` with a direct `/` command (it runs without the model). |
| `queue-full` | The queue holds `maxSize` messages; never with `maxSize: null`. |

- `submitWithResult` is the way for a composer of the app's own: the outcome
  of exactly that call, synchronously.
- `lastRejection` (`{ reason, at }`, `at` from `Date.now()`) is for a notice
  next to the built-in composers, whose return value the app does not see.
  Each refusal sets a new object, also with the same reason; the next
  accepted (sent or queued) message sets it back to null, and so do
  `clear()` and a change of the open conversation (a refusal belongs to the
  chat it happened in). Removing or sending queued messages does not touch it.
- Neither carries the text or files. The built-in composers show nothing new
  and keep the draft as before.
- Other refusals are not submit rejections: `sendNow` with
  `sendNowDuringApproval: 'refuse'` returns false and shows the approval
  hint; a message sent while `queue.storage` reads is queued.

`useChatQueue()` returns just the queue state and those actions (with
`submitWithResult` and `lastRejection`), for a headless UI:

```tsx
import { useChatQueue } from 'glirastes/react';

function MyQueue() {
  const queue = useChatQueue();
  if (queue.items.length === 0) return null;
  return (
    <ul>
      {queue.paused && <li><button onClick={queue.resumeQueue}>Resume</button></li>}
      {queue.items.map((item) => (
        <li key={item.id}>
          {item.text}
          <button onClick={() => queue.sendNow(item.id)}>Send now</button>
          <button onClick={() => queue.removeQueued(item.id)}>Remove</button>
        </li>
      ))}
    </ul>
  );
}
```

The built-in composers (`ChatInput`, `MentionInput`, `useChatComposerInput`)
stay usable while loading when the queue is on and show both send and stop.
A custom composer uses `canCompose` instead of `isLoading` to lock itself.

## `ChatQueue` component

`AiChatPanel` renders `ChatQueue` above the composer when the queue is on.
`components.ChatQueue` replaces it; `components.ChatQueue: null` hides it
(render the queue elsewhere with `useChatQueue`).

- Root `data-component="chat-queue"`, `data-state="waiting" | "paused"`,
  class `classNames.chatQueue`, `data-unstyled` with `unstyled`.
- `data-element="title"`, `"paused"` (with `data-action="resume"`),
  `"items"`, `"item"` (`data-queue-id`, `data-state="queued" | "editing"`),
  `"text"`, `"files"`, `"actions"` with `data-action="send-now"`, `"edit"`,
  `"remove"`; while editing (`beginEdit`, the queue holds at it) `"edit"` with
  `data-action="save"` (`editQueued`), `"cancel"` (`cancelEdit`).
- Renders nothing while the queue is empty. `<ChatQueue>{(queue) => …}</ChatQueue>`
  renders it yourself.
- Texts: `queueTitle` (`{count}`), `queueSendNowLabel`, `queueEditLabel`,
  `queueRemoveLabel`, `queuePausedLabel`, `queueResumeLabel`,
  `queueSaveLabel`, `queueCancelLabel`, `queueFilesLabel` (`{count}`);
  English defaults, German in `deChatLocale`.
- The approval notice of `AiChatPanel` (`data-component="approval-reminder"`)
  while a queued message waits for an open approval reads
  `queueApprovalWaitingHint`; without a queued message (a refused send) it
  stays `approvalPendingHint`. The new key is optional in `ChatLocale`, so a
  full locale object without it still compiles. Order:
  1. the app's own text of the new key (`locale` or `locales`);
  2. else the app's own `approvalPendingHint` (in `locale`, over a spread
     `deChatLocale`, in `locales` or in a full locale without the new key), so
     an app that set it sees no change;
  3. only then the built-in text: "Message waits until the approval is
     decided." (German: "Nachricht wartet, bis die Freigabe entschieden ist.").

  A built-in text set explicitly for the new key is honoured, except next to
  an own `approvalPendingHint` (that is what a spread `deChatLocale` with one
  override looks like): then the own `approvalPendingHint` wins.

## Persistence adapter

```ts
import type { ChatQueueStorage, QueuedMessage } from 'glirastes/react';

const queueStorage: ChatQueueStorage = {
  load: (sessionId) => {
    const raw = localStorage.getItem(`chat-queue:${sessionId}`);
    return raw ? (JSON.parse(raw) as QueuedMessage[]) : [];
  },
  save: (sessionId, items) => {
    if (items.length === 0) localStorage.removeItem(`chat-queue:${sessionId}`);
    else localStorage.setItem(`chat-queue:${sessionId}`, JSON.stringify(items));
  },
};

<AiChatProvider transport={transport} queue={{ enabled: true, storage: queueStorage }} />
```

- `load` runs per active conversation; a result that arrives after another
  conversation became active is discarded. Nothing is saved for a
  conversation before its `load` answered.
- Writes run one at a time per conversation; while one runs, only the latest
  state is written after it (an older write never lands after a newer one).
  A conversation is read again only after its pending write landed.
- Messages with files are never saved (file data and object URLs do not
  survive a reload) and are skipped when loaded.
- A restored queue starts paused (`'restored'`): nothing is sent after a
  reload until the user resumes or sends one with `sendNow`.
- Switching conversations keeps the stored queue of the one left;
  `clear()` saves an empty queue for the cleared one. A removed conversation's
  stored queue is the adapter's to delete.
- Queued texts are user content: store them where the conversation itself is
  allowed to be stored, and clear them on sign-out.

## Limits

- One message per run: the queue never merges messages.
- The approval resend wait (1.5 s) is a guard for transports that do not send
  an answered approval on; the AI SDK transport continues at once.
- `sendNow` with `'abort'` only stops a request that is running; while the
  chat waits for something else (an approval, a UI action) it behaves like
  `'next'`.
