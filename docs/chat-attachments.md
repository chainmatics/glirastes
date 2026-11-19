# Chat attachments

Users can attach images and PDFs to a chat message: with the paperclip
button, by pasting, or by dropping files on the input. The model receives
them as file parts. Attachments are off by default, on the client and on
the server.

## Turning them on

Server (`glirastes/server/nextjs`):

```ts
createAiChatHandler({
  ...turn,
  model,
  attachments: { enabled: true },
})(request);
```

Client (`VercelAiChat`, or `AiChatProvider` with the Vercel transport):

```tsx
<VercelAiChat endpoint="/api/chat" attachments />
```

The model must accept the file types you allow: images need a vision model,
PDFs a model or provider that reads PDF file parts.

## Server options

`attachments` on `createAiChatHandler`:

| Option | Default | Effect |
| --- | --- | --- |
| `enabled` | required | `false` refuses every file part with 400 (`attachments_disabled`) |
| `maxFiles` | `10` | file parts per message, more is 400 (`too_many_attachments`) |
| `maxFileBytes` | `20000000` (20 MB, decoded) | a larger file is 413 (`attachment_too_large`) |
| `mediaTypes` | png, jpeg, webp, gif, pdf | another type is 415 (`unsupported_attachment_type`) |
| `allowRemoteUrls` | `false` | accept `http(s)` file URLs; otherwise only `data:` URLs (400 `remote_attachment_refused`) |
| `allowWithPiiShield` | `false` | required when `piiShield` is set too, see below |

The handler checks every file part of every message in the history: a
`data:` URL must be base64, match its declared media type, and its first
bytes must match the type (400 `invalid_attachment` otherwise). An empty URL
is refused too.

`maxBodyBytes` stays 1 MB without attachments and becomes 50 MB when
`attachments.enabled` is true. An explicit `maxBodyBytes` always wins.

Audit, telemetry and metrics never carry file data. History trimming counts
a file part as about 1,000 tokens, and older turns that it keeps as text only
carry a placeholder (`[attachment <id>: name]`) instead of the file, see
"Attachment ids".

## PII shield

The PII shield only reads text. File parts pass through byte-identical and
are never sent to the PII detector, so an image or PDF can carry personal
data to the model. A handler with `piiShield` and `attachments.enabled`
therefore throws at setup unless you also set `allowWithPiiShield: true`,
which records that you accept this.

## Client options

`attachments` on the provider is `true` or an object:

| Option | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` when the object is given | `false` turns them off |
| `mediaTypes` | png, jpeg, webp, gif, pdf | accepted file types (also the picker's `accept`) |
| `maxFiles` | `10` | files per message |
| `maxFileBytes` | `20000000` | checked after `prepare` |
| `prepare` | none | `(file: File) => File \| Blob \| Promise<File \| Blob>`, runs before the size check |

Keep client and server limits in line; the server decides.

The SDK does not compress or downscale images. Do it in `prepare`, for
example by drawing the image onto a canvas and returning
`canvas.toBlob(..., 'image/jpeg', 0.85)`.

A request keeps the file data only in the two most recent user messages;
older files reach the server as `[attachment <id>: name]` text. Chats stored
with `createLocalSessionStore` keep the files in the browser, see "Keeping
attachments".

The LangGraph transport does not support attachments and throws when a
message carries files. `/` commands cannot carry attachments; the composer
refuses that send and keeps text and files.

## Attachment ids

Every attachment has an id like `att_k3J9...`, matching
`^att_[A-Za-z0-9_-]{16,64}$`. It travels in
`providerMetadata.glirastes.attachmentId` on the file part.

The server writes `[attachment <id>: <filename>]` next to every user file
part the model receives, and uses the same text as the placeholder of every
file whose data was dropped. `[`, `]`, CR and LF are stripped from file
names. Only the validated id reaches the provider as provider options; any
other provider metadata from the client is dropped.

## Keeping attachments

`createLocalSessionStore` keeps the file blobs in IndexedDB (database
`glirastes-chat-attachments`, store `files`) and restores them when a chat
loads. localStorage keeps only `url: ''` for a file, never base64. With a
store, `load` returns a promise.

| Option | Default | Effect |
| --- | --- | --- |
| `attachmentStore` | IndexedDB when `storage` is set | `AttachmentBlobStore` for the blobs; `null` keeps none |

Lifetime: Blobs are deleted when, and only when, their chat goes: `remove(id)`,
`clear(id)`, eviction by `maxSessions`, and `clearLocalSessionStore()`. No
expiry, no total-size eviction. Deletion waits for the chat's pending
writes. On the first stored blob the store calls `navigator.storage.persist()`
once, so the browser is less likely to drop the files under storage pressure.

Without IndexedDB (private windows, blocked storage) nothing throws. The
files live in memory for the page's lifetime.

Call `clearLocalSessionStore` on sign-out. It removes every key starting
with `${storageKey}:` and all stored files:

```ts
import { clearLocalSessionStore } from 'glirastes/react';

await clearLocalSessionStore({ storageKey: 'my-app-chat' });
```

It takes `{ storageKey, storage?, attachmentStore? }`. Also exported:
`createIndexedDbAttachmentStore`, `createMemoryAttachmentStore` and the types
`AttachmentBlobStore` and `StoredAttachment`. `SessionConfig.attachments`
takes an `AttachmentBlobStore` for a custom session config. In a custom store,
`put` resolves `true` once the file is written and `false` when the write
failed; the session store then tries again on the next `save`.

## Handing attachments to the app

`getChatAttachment(id)` resolves to a `StoredAttachment` or `null`.
`chatAttachmentFormData(id, field = 'file')` resolves to a `FormData` with the
file under `field`, or `null`. Both work only within the active conversation:
they look in the in-memory messages first, then the store. An id of another
chat, an unknown id or a malformed id gives `null`.

The model sees `[attachment <id>: name]`, so it can pass the id to a client
action, and the action uploads the file with the user's own session:

```ts
useAiClientAction('tasks.attachChatFile', async ({ taskId, attachmentId }) => {
  const form = await chatAttachmentFormData(attachmentId);
  if (!form) return false;
  const response = await fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: form });
  return response.ok;
}, attachChatFilePayload, { effect: 'write' });
```

Returning `false` reports failure to the model through the UI outcome
protocol (`docs/ui-action-outcomes.md`).

A derived server tool for a multipart upload route cannot work: the model
cannot produce file bytes, and the executor sends JSON. Disable that tool
with `glirastes tools policy` and use the client action instead.

## Custom composers

`useChatComposerInput()` returns the attachment state next to the rest:
`attachments`, `attachmentError`, `attachmentsEnabled`, `addFiles(files)`,
`removeAttachment(id)`, `openFilePicker()` and `attachmentInputProps` for a
hidden file input. Paste, drop and Backspace on an empty editor (removes the
last file) work through `inputProps`.

```tsx
import { AttachmentButton, AttachmentTray, RichMentionInput, useChatComposerInput } from 'glirastes/react';

function Composer() {
  const composer = useChatComposerInput();
  return (
    <form onSubmit={(event) => { event.preventDefault(); composer.submit(); }}>
      {composer.attachmentsEnabled && (
        <AttachmentTray
          attachments={composer.attachments}
          onRemove={composer.removeAttachment}
          error={composer.attachmentError}
        />
      )}
      {composer.argumentsForm}
      <input {...composer.attachmentInputProps} />
      {composer.attachmentsEnabled && <AttachmentButton onClick={composer.openFilePicker} />}
      <RichMentionInput ref={composer.inputRef} {...composer.inputProps} />
      <button type="submit" disabled={!composer.canSend}>Senden</button>
    </form>
  );
}
```

A custom `onSubmit` passed to `useChatComposerInput` gets the files as its third
argument. The slots `components.AttachmentTray` and
`components.AttachmentButton` replace the default pieces in the shipped
composer.

## Body limits in front of the handler

The handler's `maxBodyBytes` is not the only limit:

- Next.js: when a middleware (`proxy` in Next.js 16) runs on the chat route,
  Next.js buffers at most 10 MB of the body for it. Raise
  `experimental.middlewareClientMaxBodySize` (Next.js 16:
  `experimental.proxyClientMaxBodySize`) in `next.config`, or exclude the chat
  route from the middleware matcher.
- NestJS or Express in front of the handler: the JSON body parser defaults
  to 100 kB. Raise it for the chat route, for example
  `app.useBodyParser('json', { limit: '50mb' })` or `json({ limit: '50mb' })`.
  Only the Next.js handler (`createAiChatHandler`) checks the attachments
  themselves.
- Reverse proxies (nginx `client_max_body_size`, serverless platform limits)
  need the same headroom.
