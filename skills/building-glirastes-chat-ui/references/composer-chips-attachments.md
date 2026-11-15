# Composer, entity chips and attachments

All names below come from `glirastes/react` unless noted.

## Contents

- Pills
- Starting a chat from the app (`useChatComposer`)
- Entity chips in answers (`entityLinks`)
- Attachments
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
- The model must read the allowed types: images need a vision model, PDFs a
  provider that reads PDF file parts.
- Client: `attachments` is `true` or `{ mediaTypes, maxFiles, maxFileBytes,
  prepare }`; `prepare(file)` returns a `File` or `Blob` and runs before the
  size check. Keep client limits in line with the server's.
- Only the two most recent user messages carry file data; older files go as
  `[attachment: name]`. `createLocalSessionStore` keeps no file data (shown
  as no longer available).
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

## A chat without the SDK provider

The SDK chat hands every tool result to `dispatchToolResultUiActions` (from
`glirastes/browser`). A chat UI of the app's own that renders tool results
itself calls `dispatchToolResultUiActions(result, bus?, { routeTimeoutMs })`
for each successful result: otherwise generated navigation, filter and client
actions never run, and a page-bound action (`{ route }`) never opens its page.
It navigates through the navigation bridge, waits up to `routeTimeoutMs`
(default 5000) for the page to register the handler, and rejects when it does
not or when a handler returns `false`. Server `success: true` means only that
an action request was created; check `executionStatus: 'unconfirmed'`. Local
feedback distinguishes rejection, missing handlers, exceptions and timeouts.
Never retry timed-out work automatically: an already-running handler may still
have an effect. Custom clients should pass an abort `signal` on session changes
and deduplicate tool-call IDs, including restored history. See
[Browser outcomes](../../../docs/browser-action-outcomes.md).

Custom clients can import `UiActionDispatchError` and the `UiActionFailureStatus`
type from `glirastes/browser`. Catch the typed error around
`await dispatchToolResultUiActions(result, bus, { signal })`, then display a
localized label for `error.status`. Do not turn exceptions or timeouts into
success and do not resend the tool call automatically.
