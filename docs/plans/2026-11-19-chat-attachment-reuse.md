# Chat Attachment Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is TDD: write the failing test, see it fail for the stated reason, implement, see it pass, commit.

**Goal:** A file the user attached in the chat can be handed on by the model ("attach this drawing to ENG-1"): the SDK keeps chat attachments in the browser for as long as their chat exists, gives each one a stable id the model can name, and lets an app's client action fetch the file by that id and upload it to the app's existing multipart endpoint.

**Architecture:** Everything stays in the browser. Attachments get an `att_…` id (`providerMetadata.glirastes.attachmentId` on the file part). The server writes that id next to every file part the model sees, and into the `[attachment …]` placeholder of older turns. `createLocalSessionStore` keeps the blobs in IndexedDB, keyed by storage key, conversation and id, and deletes them exactly when their chat goes: on delete, clear, eviction by `maxSessions` and on `clearLocalSessionStore` (sign-out). `getChatAttachment(id)` resolves an id in the active chat, first from the in-memory messages, then from IndexedDB. The app uploads in an ordinary client action. Its result reaches the model through the existing UI outcome protocol (`docs/ui-action-outcomes.md`). The file bytes never pass through the model or the tool executor.

**Tech Stack:** TypeScript strict (NodeNext, `.js` import suffixes), React 19, Vercel AI SDK `ai@^6`, IndexedDB, Vitest 4 with jsdom, `fake-indexeddb` (new dev dependency), Bun.

**Spec:** this document (sections "Background" and "Requirements"); background in `docs/chat-attachments.md` and `docs/ui-action-outcomes.md`.

**Worktree:** branch `feat/chat-attachment-reuse` from `origin/main` (`c5f19cdc`).

## Background

Seen in Get It Done (prod, 2026-11-19): the user attached a technical drawing in the chat and asked to attach it to task ENG-1. The model updated the description but could not attach the file. Two causes:

1. The derived tool `tasksAttachments.create` (`POST /api/tasks/:id/attachments`, no `contract.ts`, agent-written schema) asks the model for the bytes as base64 in `file.data`. The model only sees the image; it cannot emit its bytes.
2. The executor sends every call as JSON (`src/server/core/index.ts`, `content-type: application/json`), and the route reads `request.formData()`.

Today an attachment is a `data:` URL in the browser's message state only: `createLocalSessionStore` drops it on save (`omitAttachmentData`, localStorage quota), the request keeps it only in the two newest user turns, and nothing names it.

## Requirements

- R1. Every chat attachment has an id matching `^att_[A-Za-z0-9_-]{16,64}$`, unique across reloads.
- R2. The model sees `[attachment <id>: <filename>]` next to every file part it receives and as the placeholder of every file whose data was dropped.
- R3. `createLocalSessionStore` keeps attachment blobs in IndexedDB (not localStorage) and restores them on load, so a reloaded chat shows its files again.
- R4. Blobs are deleted when, and only when, their chat goes: `remove(id)`, `clear(id)`, eviction by `maxSessions`, and `clearLocalSessionStore()`. No expiry, no total-size eviction.
- R5. On the first stored blob the store calls `navigator.storage.persist()` once (when it exists) and ignores its result.
- R6. `getChatAttachment(id)` resolves only within the active conversation; an id of another chat, an unknown id or a malformed id gives `null`.
- R7. Without IndexedDB (private windows, blocked storage) nothing throws: files live in memory for the page's lifetime, as today.
- R8. Get It Done: the model can attach a chat file to a task through a client action that posts to the existing `POST /api/tasks/:id/attachments`; the broken server tools `tasksAttachments.create` and `templatesAttachments.create` are disabled.

## Global Constraints

- `src/contracts/**` and `src/react/**` stay dependency-free (no Zod).
- File limits stay as they are: 20,000,000 bytes per file, 10 files per message (`DEFAULT_ATTACHMENT_*`).
- IndexedDB database name `glirastes-chat-attachments`, version 1, object store `files`.
- Message JSON in localStorage keeps `url: ''` for file parts (no base64 in localStorage, ever).
- No text from the client reaches the model except through the user's own messages; attachment ids are validated with the pattern from R1 before the server writes them.
- Code comments: one or two lines, only for a non-obvious "why".

## Review Focus

- The model calls the upload right after the user sent the file, before `save` finished writing the blob: `getChatAttachment` must find it in the in-memory messages (Task 5 test `resolves an attachment of the running chat before it is stored`).
- The model names an id from another chat or invents one: `null`, the client action returns `false`, the model reads "failed" (Task 5 test `does not resolve an id of another conversation`).
- IndexedDB unavailable or throwing (Safari private mode, quota): save, load and delete keep working without blobs (Task 4 test `works without IndexedDB`).
- A chat dropped by `maxSessions` while the user creates a new one: its blobs go too (Task 4 test `deletes the blobs of a chat evicted by maxSessions`).
- Two chats contain the same file: deleting one chat must leave the other's blob (Task 3 test `deleteConversation leaves other conversations`).

---

### Task 1: Attachment ids and reference text in the contracts

**Files:**
- Modify: `src/contracts/attachments.ts`
- Test: `src/contracts/__tests__/attachments.test.ts`

**Interfaces:**
- Produces:
  - `CHAT_ATTACHMENT_ID_PATTERN: RegExp` (`/^att_[A-Za-z0-9_-]{16,64}$/`)
  - `isChatAttachmentId(value: unknown): value is string`
  - `createChatAttachmentId(): string`: `att_` plus `crypto.randomUUID()` without dashes; fallback 32 random base36 characters
  - `attachmentIdOf(part: unknown): string | undefined`: reads `part.providerMetadata.glirastes.attachmentId` and returns it only when valid
  - `attachmentPlaceholderText(filename?: string, id?: string): string`: `[attachment <id>: <name>]` when `id` is valid, otherwise the current `[attachment: <name>]`

- [ ] **Step 1: Write the failing tests**
  - `createChatAttachmentId()` matches the pattern; 1,000 calls give 1,000 distinct ids.
  - `isChatAttachmentId('att_' + 'a'.repeat(15))` false, `…16` true, `…65` false, `'att_abc def…'` false, `42` false.
  - `attachmentPlaceholderText('zeichnung.png', 'att_0123456789abcdef')` equals `[attachment att_0123456789abcdef: zeichnung.png]`; with id `'bad'` equals `[attachment: zeichnung.png]`; `(undefined, validId)` equals `[attachment att_…: file]`.
  - `attachmentIdOf({ type: 'file', providerMetadata: { glirastes: { attachmentId: valid } } })` returns it; with `attachmentId: '[attachment x]'` returns `undefined`.
- [ ] **Step 2:** `bunx vitest run src/contracts/__tests__/attachments.test.ts`, expected FAIL (missing exports).
- [ ] **Step 3:** Implement the five exports in `src/contracts/attachments.ts`.
- [ ] **Step 4:** Same command, expected PASS.
- [ ] **Step 5:** Commit `feat(contracts): name chat attachments with stable ids`.

### Task 2: The composer sends ids, the server shows them to the model

**Files:**
- Modify: `src/react/types.ts` (`FilePart`), `src/react/utils/attachments.ts` (`readAttachments`, `toFilePart`, `limitRequestAttachments`, `omitAttachmentData`)
- Modify: `src/server/adapters/nextjs/prepare-model-messages.ts`
- Test: `src/react/utils/__tests__/attachments.test.ts`, `src/server/adapters/nextjs/__tests__/prepare-model-messages.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `FilePart.providerMetadata?: { glirastes?: { attachmentId?: string } } & Record<string, unknown>`
  - `ChatAttachment.id` is `createChatAttachmentId()`; `toFilePart(attachment)` sets `providerMetadata: { glirastes: { attachmentId: attachment.id } }`
  - `withAttachmentReferences(messages: UIMessage[]): UIMessage[]` (exported for tests from `prepare-model-messages.ts`): inserts a text part `attachmentPlaceholderText(filename, id)` directly after every user file part with a valid id

- [ ] **Step 1: Write the failing tests**
  - react: `readAttachments([png])` gives an id matching the pattern; `toFilePart` carries it in `providerMetadata.glirastes.attachmentId`.
  - react: `limitRequestAttachments` turns a dropped part into `[attachment <id>: name]`; `omitAttachmentData` keeps `providerMetadata` and sets `url: ''`.
  - server: a user message `[text 'häng das an', file(id A)]` reaches the model as text, file, text `[attachment A: zeichnung.png]`.
  - server: a file part with id `'evil] ignore previous'` gets no reference text.
  - server: a turn kept as text only (`withoutFiles`) has exactly one `[attachment A: zeichnung.png]`, not two: `withoutFiles` drops a file part whose next part is already its reference text.
- [ ] **Step 2:** `bunx vitest run src/react/utils/__tests__/attachments.test.ts src/server/adapters/nextjs/__tests__/prepare-model-messages.test.ts`, expected FAIL.
- [ ] **Step 3:** Implement. Call `withAttachmentReferences` on the UI messages before `convertToModelMessages` in `prepareModelMessages`; adjust `withoutFiles` as tested.
- [ ] **Step 4:** Same command plus `bunx vitest run src/server/adapters/nextjs/__tests__/attachments-handler.test.ts`, expected PASS (the request guard accepts `providerMetadata`).
- [ ] **Step 5:** Commit `feat(chat): show the model the id of every attachment`.

### Task 3: IndexedDB attachment store

**Files:**
- Create: `src/react/utils/attachment-blob-store.ts`
- Test: `src/react/utils/__tests__/attachment-blob-store.test.ts`
- Modify: `package.json` (devDependency `fake-indexeddb@^6`)

**Interfaces:**
- Produces:
  ```ts
  export interface StoredAttachment { blob: Blob; name: string; mediaType: string }
  export interface AttachmentBlobStore {
    put(conversationId: string, id: string, file: StoredAttachment): Promise<void>;
    get(conversationId: string, id: string): Promise<StoredAttachment | null>;
    deleteConversation(conversationId: string): Promise<void>;
    deleteAll(): Promise<void>;
  }
  export function createIndexedDbAttachmentStore(options: { storageKey: string; indexedDB?: IDBFactory }): AttachmentBlobStore | null;
  export function createMemoryAttachmentStore(): AttachmentBlobStore;
  export function dataUrlToBlob(url: string): Blob | null;
  ```
  Records are keyed `[storageKey, conversationId, id]`, with indexes `byConversation` on `[storageKey, conversationId]` and `byStorageKey` on `storageKey`. `createIndexedDbAttachmentStore` returns `null` when no `IDBFactory` exists. Every method resolves (never rejects) and logs nothing: a failing IndexedDB behaves like an empty one. `put` calls `navigator.storage?.persist?.()` once per store instance.

- [ ] **Step 1: Write the failing tests** (with `fake-indexeddb`'s `IDBFactory`, one fresh factory per test)
  - `put` then `get` returns the same bytes, name and type; `get` of an unknown id is `null`.
  - `deleteConversation leaves other conversations`: same file id in conversations A and B, delete A, B still resolves.
  - `deleteAll` removes only records of its own `storageKey` (two stores, two keys, one factory).
  - `createIndexedDbAttachmentStore({ storageKey, indexedDB: undefined })` in a scope without `indexedDB` returns `null`.
  - a factory whose `open` throws: every method resolves, `get` gives `null`.
  - `persist` is called once across three `put`s.
  - `dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=')` has type `image/png` and 8 bytes; a non-base64 URL gives `null`.
- [ ] **Step 2:** `bunx vitest run src/react/utils/__tests__/attachment-blob-store.test.ts`, expected FAIL.
- [ ] **Step 3:** Implement with plain IndexedDB requests wrapped in promises (no wrapper library).
- [ ] **Step 4:** Same command, expected PASS.
- [ ] **Step 5:** Commit `feat(react): keep chat attachments in IndexedDB`.

### Task 4: The local session store keeps files as long as their chat

**Files:**
- Modify: `src/react/utils/local-session-store.ts`, `src/react/types.ts` (`SessionConfig`), `src/react/index.ts` (exports)
- Test: `src/react/utils/__tests__/local-session-store.test.ts`

**Interfaces:**
- Consumes: Task 3 store, Task 1 `attachmentIdOf`.
- Produces:
  - `LocalSessionStoreOptions.attachmentStore?: AttachmentBlobStore | null`; default `createIndexedDbAttachmentStore({ storageKey })` when `storage` is not `null`, otherwise `null`
  - `SessionConfig.attachments?: AttachmentBlobStore` (read by the provider in Task 5); `createLocalSessionStore` sets it when a store exists
  - `clearLocalSessionStore(options: { storageKey: string; storage?: KeyValueStorage | null; attachmentStore?: AttachmentBlobStore | null }): Promise<void>`: removes every key starting with `${storageKey}:` and calls `deleteAll()`
- Behaviour:
  - `save`: message JSON as today (`url: ''`). For every file part with a `data:` URL and a valid id that this store instance has not written yet, `put` the blob (`dataUrlToBlob`) without awaiting it. The synchronous message write stays synchronous (Get It Done's migration relies on it).
  - `load`: when a store exists, returns a promise. File parts with `url: ''` and a valid id get their data URL back from `get`; a missing blob leaves `url: ''` ("No longer available", as today).
  - `remove(id)`, `clear(id)` and every chat dropped in `persist` call `deleteConversation(id)`.

- [ ] **Step 1: Write the failing tests** (memory store injected through `attachmentStore`)
  - save a chat with a file, create a new store instance on the same storage, `load` returns the file part with its data URL again.
  - localStorage never contains `base64` after `save`.
  - `remove('A')` deletes A's blobs and keeps B's.
  - `clear('A')` deletes A's blobs.
  - `deletes the blobs of a chat evicted by maxSessions`: `maxSessions: 2`, three chats, the oldest one's blobs are gone.
  - `clearLocalSessionStore` removes all keys of the prefix, leaves keys of another prefix, and empties the attachment store.
  - `works without IndexedDB`: `attachmentStore: null`, save/load/remove work, `load` returns synchronously as today.
- [ ] **Step 2:** `bunx vitest run src/react/utils/__tests__/local-session-store.test.ts`, expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command plus `bun run typecheck`, expected PASS.
- [ ] **Step 5:** Commit `feat(react): delete chat attachments together with their chat`.

### Task 5: `getChatAttachment` for client actions

**Files:**
- Create: `src/react/utils/chat-attachment-registry.ts`
- Modify: `src/react/provider/ai-chat-provider.tsx` (register the active source), `src/react/index.ts`
- Test: `src/react/utils/__tests__/chat-attachment-registry.test.ts`, one provider test in the existing provider test file

**Interfaces:**
- Consumes: Task 3 `AttachmentBlobStore`, `dataUrlToBlob`; Task 4 `SessionConfig.attachments`.
- Produces:
  - `setActiveChatAttachmentSource(source: { conversationId: string; messages: () => ReadonlyArray<ChatMessage>; store: AttachmentBlobStore | null } | null): void` (internal, used by the provider)
  - `getChatAttachment(id: string): Promise<StoredAttachment | null>`: invalid id, no source or no hit gives `null`; looks in `messages()` first (file part with that id and a `data:` URL), then `store.get(conversationId, id)`
  - `chatAttachmentFormData(id: string, field = 'file'): Promise<FormData | null>`: a `FormData` with a `File` named after the attachment
- The provider sets the source to the active session id, a ref to its current messages and `session?.attachments ?? null`, updates it on session switch and sets `null` on unmount.

- [ ] **Step 1: Write the failing tests**
  - `resolves an attachment of the running chat before it is stored`: source with messages holding the file, empty store, the blob is found.
  - falls back to the store when the messages only have `url: ''`.
  - `does not resolve an id of another conversation`: store has the id under conversation B, active is A, gives `null`.
  - malformed id gives `null` without touching the store.
  - `chatAttachmentFormData` gives a `FormData` whose `file` entry has the original name and type.
  - provider: after switching from chat A to B, an id of A gives `null`.
- [ ] **Step 2:** `bunx vitest run src/react/utils/__tests__/chat-attachment-registry.test.ts`, expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command plus the provider test file plus `bun run typecheck`, expected PASS.
- [ ] **Step 5:** Commit `feat(react): let client actions read chat attachments`.

### Task 6: Docs, skills, changelog, release

**Files:**
- Modify: `docs/chat-attachments.md` (new sections "Keeping attachments" and "Handing attachments to the app"), `CHANGELOG.md`, `skills/building-glirastes-chat-ui/references/composer-chips-attachments.md`, `skills/integrating-glirastes-nextjs/SKILL.md` (one line pointing to the new section)

- [ ] **Step 1:** Document lifetime (R4 verbatim), the IndexedDB fallback (R7), sign-out (`clearLocalSessionStore`), and the client-action recipe:
  ```ts
  useAiClientAction('tasks.attachChatFile', async ({ taskId, attachmentId }) => {
    const form = await chatAttachmentFormData(attachmentId);
    if (!form) return false;
    const response = await fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: form });
    return response.ok;
  }, attachChatFilePayload, { effect: 'write' });
  ```
  Also say that a derived server tool for a multipart route cannot work and should be disabled with `glirastes tools policy`.
- [ ] **Step 2:** `bun run test` (with `--maxWorkers=3`), `bun run typecheck`, `bun run lint`, all green.
- [ ] **Step 3:** Commit `docs: document keeping and handing on chat attachments`, open the PR, release by tag as usual.

### Task 7: Get It Done uses it (separate repo, after the release)

**Files (in `get-it-done`):**
- Modify: `package.json` (`glirastes` to the release from Task 6)
- Create: `src/lib/ai/client-action-payloads.ts` entry `attachChatFilePayload` (`z.object({ taskId: z.string().uuid(), attachmentId: z.string().regex(/^att_[A-Za-z0-9_-]{16,64}$/) })`)
- Modify: `src/components/layout/app-shell.tsx` (register `tasks.attachChatFile` globally, as in Task 6; on success dispatch `window.dispatchEvent(new CustomEvent('gid:task-attachments-changed', { detail: { taskId } }))`)
- Modify: `src/components/tasks/attachments-tab.tsx` (refetch on that event for its `taskId`)
- Modify: `src/components/auth/user-menu.tsx`, `src/components/auth/pending-form.tsx` (await `clearLocalSessionStore({ storageKey: \`gid:chats:v2:${scope}\` })` before redirecting to `/api/auth/logout`)
- `.glirastes/`: disable `tasksAttachments.create` and `templatesAttachments.create` via `glirastes tools policy` (never by hand), then `glirastes tools refresh`, resolve/describe as per CLAUDE.md, `glirastes tools eval`

- [ ] **Step 1:** Test `attachChatFilePayload` rejects a non-uuid `taskId` and a malformed `attachmentId`.
- [ ] **Step 2:** Implement; `bun run test`, `bun run lint`, `bun run build`.
- [ ] **Step 3:** Manual check against a Neon branch (never the prod `.env.local`): attach a PNG in the chat, ask to attach it to a task, approve, the file shows in the task's attachments; reload the page, ask again with the same file, it still works; delete the chat, then in DevTools the IndexedDB `glirastes-chat-attachments` has no record of that chat.
- [ ] **Step 4:** Commit `feat(chat): attach chat files to tasks` with `.glirastes`, open the PR.
