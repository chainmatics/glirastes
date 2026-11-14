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
carry a placeholder (`[attachment: name]`) instead of the file.

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
older files reach the server as `[attachment: name]` text. Chats stored with
`createLocalSessionStore` keep no file data: those files show as "No longer
available".

The LangGraph transport does not support attachments and throws when a
message carries files. `/` commands cannot carry attachments; the composer
refuses that send and keeps text and files.

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
