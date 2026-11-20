# Composer, entity chips and attachments

All names below come from `glirastes/react` unless noted.

## Contents

- Pills
- Starting a chat from the app (`useChatComposer`)
- Entity chips in answers (`entityLinks`)
- Attachments
- Message queue
- A chat without the SDK provider

## Pills

With `chatInteractions` (or `completionProviders`) the default `ChatInput`
is the pill composer: a picked `/` command and a picked `@` entity are pills
(`data-mention-kind="command"` / `"entity"`). Backspace behind and Delete
before a pill remove it whole.

- Colors: `theme.colors.pillCommand`, `pillCommandText`, `pillEntity`,
  `pillEntityText`, as CSS `--cm-pill-command-bg`, `--cm-pill-command-text`,
  `--cm-pill-entity-bg`, `--cm-pill-entity-text`.
- An `unstyled` chat or a composer of the app's own on `RichMentionInput`
  imports `glirastes/react/pills.css` and sets those variables itself.
- `RichMentionInput commandPills={false}` keeps a command as `/slug ` text.

## Starting a chat from the app

`useChatComposer()` works anywhere below `AiChatProvider` / `VercelAiChat`,
for a "Chat about this" menu entry or an AI button in a detail view:

| Member | Effect |
| --- | --- |
| `open()` | Calls the provider's `onOpenRequest`, else opens the surrounding `AssistantLayoutProvider` |
| `chatAbout(entity, { command?, args?, text?, append? })` | `open()`, then sets the draft (or appends) to command pill, entity pill and text, and focuses the editor |
| `insertMention({ type, id, label? })` | `@` pill at the caret; without `label` the entity's `resolve` looks it up |
| `insertCommand(id, args?)` | `/` pill of a known command; `args` fill its arguments, so sent alone it runs without the form |
| `setDraft(text, mentions?)`, `insertText`, `clear`, `focus` | The draft |
| `hasCommand(id)`, `hasEntity(type)`, `chatAboutLabel` | For building menus ("Chat about this", German "Mit KI besprechen") |

- A component that also renders without a chat (tests, other pages) uses
  `useOptionalChatComposer()`, which is `null` outside the provider.
- Requests wait for a mounted composer, so a chat that mounts its panel only
  on open still receives them. Pass `onOpenRequest` to the provider when the
  app shows the chat itself (no `AssistantWorkspace`).
- A composer on `useChatComposerInput` receives the requests by itself. Any
  other own composer on `RichMentionInput` connects with
  `useChatComposerTarget(inputRef, { onChange })`.
- Do not confuse `useChatComposer()` (this programmatic API) with
  `useChatComposerInput()` (the logic for a custom input). In the
  `0.8.0-chat.*` prereleases the latter was called `useChatComposer(options)`;
  rename such calls.

## Entity chips in answers

`entityLinks` on the provider turns references in assistant text into
clickable chips. Memoize it.

```tsx
const entityLinks = useMemo(() => ({
  matchers: [{ type: 'task', pattern: /[A-Z][A-Z0-9]{1,5}-\d+/, resolve: (key) => lookupTask(key) }],
  open: (ref) => (ref.type === 'task' ? openTaskDetails(ref.id) : false),
}), []);
<VercelAiChat endpoint="/api/chat" chatInteractions={chatInteractions} entityLinks={entityLinks} />
```

| Field | Meaning |
| --- | --- |
| `matchers` | `{ type, pattern, resolve? }`; whole words only. `resolve(match)` returns `{ id, label }` or `undefined` (not visible to this user: stays text); cached per matched text |
| `known` | default `true`: names the conversation already referenced (`@` mentions, hits of an entity's search tool) become chips |
| `minLabelLength` | default 4; shorter known names stay text |
| `open(ref)` | opens a chip; return `false` to fall through to the entity's derived "Open" action (`ui.navigate` through the navigation bridge) |
| `canOpen(type)` | which types `open` handles; default all |
| `mentionMarkers` | `'plain'` (default, as before): a text part with a `{{mention:…}}` marker renders without Markdown; `'markdown'`: Markdown stays, each marker an inline chip (`MentionMarkers` and `markdownWithMentionMarkers` for a custom bubble) |
| `verifyMentions` | default `true` with `'markdown'`: a chip only for an id the conversation showed by declaration (`outputEntities`, a user's `@` mention, a search hit), never a field-name guess; else the label stays text; `false` turns it off |
| `unresolvedMentions` | an assistant's marker of a declared type whose id no message up to its own showed (same check, either `mentionMarkers`; judged only if its message and every earlier assistant message with a tool result have declarations: its own live turn's, else the `entityDeclarations` prop): `'keep'` (default, as before) or `'text'` (the name, no chip). Type `ChatUnresolvedMentionPolicy`; `unresolvedMention(marker)` decides per marker (pure; may run every render), `undefined` falls back. Custom bubble: `useChatEntityLinks().unresolvedMention(mention, { id, role })` (type `MentionMarkerMessage`), render the name for `'text'`; `MentionMarkers message={{ id, role }}`. `chatInteractions.loading`: default true only while a `useChatInteractionsData` load waits |

- Without `open` and without a derived "Open" page a chip shows but is not
  clickable. Opening never sends a chat message. `@` pills in sent messages
  open the same way, also without `entityLinks`.
- A matcher hit followed by a known name ("MAR-5 Flyer drucken", also with
  `:` or a dash between) is one chip. `resolve` still gets only the hit;
  code on `splitEntityText` reads it from the segment's `match` (`text` is
  the whole phrase).
- Replacing the `Markdown` slot drops the chips unless the renderer uses
  `useChatEntityLinks().markdownComponents` (for `react-markdown`) or
  `linkify(children)`. `EntityText` renders one string, `EntityLinkChip` one
  chip.

## Attachments

Server, `attachments` on `createAiChatHandler`:

| Option | Default | Refusal |
| --- | --- | --- |
| `enabled` | required | 400 `attachments_disabled` |
| `maxFiles` | 10 per message | 400 `too_many_attachments` |
| `maxFileBytes` | 20 MB decoded | 413 `attachment_too_large` |
| `mediaTypes` | png, jpeg, webp, gif, pdf | 415 `unsupported_attachment_type` |
| `allowRemoteUrls` | `false`: only `data:` URLs | 400 `remote_attachment_refused` |
| `allowWithPiiShield` | `false`; with `piiShield` the handler throws at setup without it | — |

- Every file in the history is checked (base64, declared type, magic bytes;
  400 `invalid_attachment`). `maxBodyBytes` becomes 50 MB; an explicit value
  wins.
- Every file has an id `att_...` (`providerMetadata.glirastes.attachmentId`);
  the model sees `[attachment <id>: name]`.
- The model must read the allowed types: images need a vision model, PDFs a
  provider that reads PDF file parts.
- Client: `attachments` is `true` or `{ mediaTypes, maxFiles, maxFileBytes,
  prepare }`; `prepare(file)` returns a `File` or `Blob` and runs before the
  size check. Keep client limits in line with the server's.
- Only the two most recent user messages carry file data; older files go as
  `[attachment <id>: name]`. `createLocalSessionStore` keeps the blobs in
  IndexedDB (`attachmentStore`, `null` keeps none) and restores them on load;
  `load` then returns a promise. Blobs go only with their chat (`remove`,
  `clear`, `maxSessions` eviction, `clearLocalSessionStore`), no expiry. Call
  `clearLocalSessionStore({ storageKey })` on sign-out. Without IndexedDB the
  files stay in memory. A custom store implements `AttachmentBlobStore` (items
  are `StoredAttachment`; `put` resolves `true` when written, `false` when it
  failed, and the next `save` retries); `createIndexedDbAttachmentStore` and
  `createMemoryAttachmentStore` are the two shipped ones.
- To hand a file to the app (an upload route), a client action calls
  `chatAttachmentFormData(attachmentId)` (or `getChatAttachment(id)`; `null`
  for an id outside the active chat), posts the form and returns
  `response.ok`; `false` reports failure to the model. A derived server tool
  for a multipart route cannot work: disable it with `glirastes tools policy`.
  Recipe: `docs/chat-attachments.md`, "Handing attachments to the app".
- The LangGraph transport throws on a message with files. `/` commands carry
  no files; the composer refuses that send and keeps text and files.
- Custom composer on `useChatComposerInput()`: `attachments`,
  `attachmentError`, `attachmentsEnabled`, `addFiles(files)`,
  `removeAttachment(id)`, `openFilePicker()`, `attachmentInputProps`. Render
  `AttachmentTray` (`attachments`, `onRemove`, `error`),
  `<input {...composer.attachmentInputProps} />` and `AttachmentButton`.
  Paste, drop and Backspace on an empty editor work through `inputProps`. A
  custom `onSubmit` gets the files as third argument. `RichMentionInput`
  takes `onFiles`, `onBackspaceEmpty` and `allowEmptySubmit`, and keeps its
  text when `onSubmit` returns `false`.
- Body limits in front of the handler: a Next.js middleware / `proxy` on the
  chat route buffers 10 MB (`experimental.middlewareClientMaxBodySize`,
  Next.js 16 `experimental.proxyClientMaxBodySize`, or keep the route out of
  the matcher); NestJS/Express JSON parsers default to 100 kB
  (`json({ limit: '50mb' })`); reverse proxies need the same headroom.

## Message queue

Off by default; `queue={{ enabled: true }}` on the provider (`config.queue` on
`<glirastes-chat>`). Without it nothing changes. Full behaviour table:
`docs/chat-queue.md`.

- A message sent while a run loads or an approval is open is queued
  (`QueuedMessage`: `id`, `text`, `createdAt`, captured `mentions`, `files`)
  and sent once idle, FIFO, one run at a time; commands, mentions and
  `onBeforeSend` apply when it is sent. Never sent as a clarification answer
  by itself; never decides an approval.
- `ChatQueueConfig`: `autoFlush` (true), `sendNowBehavior` (`'next'` /
  `'abort'`), `maxSize` (10; `null`/`Infinity` lifts it), `pauseOn`
  (`ChatQueuePauseTrigger[]`, default `error`, `aborted`, `safety-stop`,
  `truncation`), `sendNowDuringApproval` (`'refuse'` / `'reject-approval'`),
  `storage` (`ChatQueueStorage` `{ load, save }`; file items are never saved;
  a restored queue starts paused), `onQueueChange` (`ChatQueueChangeEvent`
  `{ queued, paused, reason }`, `ChatQueueChangeReason`).
- Context: `submit(text, options?)` returns `ChatSubmitResult`
  (`'sent' | 'queued' | 'rejected'`); `send` keeps its boolean; `queue`
  (`ChatQueueState` `{ enabled, items, paused, restoring, editingId }`),
  `canCompose`, `sendNow`, `removeQueued`, `editQueued`, `beginEdit` /
  `cancelEdit` (an open edit holds the queue at that message; call `beginEdit`
  when a custom UI opens an editor), `clearQueue`, `resumeQueue`, `pauseQueue`.
  `useChatQueue()` returns `ChatQueueApi` (state plus actions).
- Why a message was refused (also without the queue): `submitWithResult`
  returns `ChatSubmitOutcome` (`{ status: 'sent' | 'queued' }` or
  `{ status: 'rejected', reason }`); `lastRejection` (`ChatSubmitRejection`
  `{ reason, at }` or null; context and `useChatQueue()`) also covers the
  built-in composers and is null again after the next accepted message,
  `clear()` or a change of the open conversation.
  `ChatSubmitRejectionReason`: `session`, `approval-open` (only without the
  queue), `attachments-off`, `files-with-command`, `queue-full`. No content;
  the built-in UI shows nothing new.
- `ChatQueue` (`ChatQueueProps`: `className`, `children(queue)`) renders above
  the composer in `AiChatPanel`; `components.ChatQueue` replaces it, `null`
  hides it. A custom composer locks on `!canCompose`, not on `isLoading`.
- `clear()` and another active conversation empty the queue; a language
  change keeps it. A full `ChatLocale` object needs the `queue*` keys except
  the optional `queueApprovalWaitingHint` (the panel's approval notice while
  a queued message waits). Order: the app's own text of that key, else the
  app's own `approvalPendingHint`, else the built-in "Message waits until the
  approval is decided." / "Nachricht wartet, bis die Freigabe entschieden ist."

## A chat without the SDK provider

The SDK chat hands every tool result to `dispatchToolResultUiActions` (from
`glirastes/browser`). A chat UI of the app's own that renders tool results
itself calls `dispatchToolResultUiActions(result, bus?, { routeTimeoutMs })`
for each successful result: otherwise generated navigation, filter and client
actions never run, and a page-bound action (`{ route }`) never opens its page.
It navigates through the navigation bridge, waits up to `routeTimeoutMs`
(default 5000) for the page to register the handler, and rejects when it does
not or when a handler returns `false`.
`runToolResultUiActions(result, bus?, { timeoutMs, routeTimeoutMs, signal })`
(`RunToolResultUiActionsOptions`) does the same without throwing and resolves
a `UiActionRunResult` `{ code, dispatched, durationMs, error? }` (`null` when
`toolResultUiActions(result)` finds no generated UI action):
the codes are listed in `hooks-and-building-blocks.md`. Run the results of one
answer one after another in call order, and only results your own running
request delivered: never results restored from a stored history or results
that already carry an `outcome`. Such an own chat gets the fallback (the
0.17.3 result `{ success: true, … }`, no marker, the model answers at once)
unless it sends `glirastesUiOutcomes: 1` (then `{ handedOff: true, … }`),
writes `outcome: { v: 1, code }` into every `awaitsOutcome` result (no code
for `timeout`/`unconfirmed`) and sends the history again once all have one;
the package's `docs/ui-action-outcomes.md` has the protocol.
