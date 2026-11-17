---
name: setting-up-glirastes-memory
description: Use when the chat should remember more than the last messages - a rolling summary of long chats, notes about a user across chats, notes shared by the users of a tenant - or when choosing between browser and database storage for them, during setup or later.
---

# Setting Up Glirastes Memory

You are the app's existing coding agent. Glirastes never calls a model for
this work; you read the code, ask the developer the questions below and wire
the result. The chat runtime writes summaries with the app's own model
access.

Memory has three independent parts, all configured through `memory` on
`createAiChatHandler`:

| Part | What it does | Storage |
| --- | --- | --- |
| Chat summary | older turns of one chat fold into a running summary instead of dropping out of the context | in the chat itself, as a part of the assistant message; no table |
| User notes | short facts and preferences every chat of one user sees | the browser, or a table |
| Shared notes | conventions every user of one tenant sees | a table only |

The model writes notes through two built-in tools, `memory_remember` and
`memory_forget`, when the user asks or states a lasting preference. Nothing
is extracted silently.

## Boundaries

- Never edit `.glirastes/tool-policy.json` or generated files. The memory
  tools are handler built-ins, not generated tools; they need no policy entry.
- Scope keys come from the verified server session (`memory.scope`), never
  from the request body, a header the client sets or a query parameter. A
  shared scope is one tenant; never use a constant key across tenants.
- Never store secrets, credentials or special categories of personal data in
  notes. Notes are user content: they need the same protection, retention
  and deletion as chat messages. Tell the developer when the app has a data
  protection process that must cover a new table.
- Browser notes live in `localStorage` of one browser profile. Do not offer
  them for shared devices or when notes must follow the user across devices.
- Run migrations and the store test against a development or test database,
  never production. Applying the table in production is the developer's step.
- No hosted memory service: notes stay in the app's own database.

## Workflow

1. Read the existing chat handler and how it resolves the user and tenant.
   Find the app's database access (Drizzle, Prisma, plain SQL, other) and its
   migration workflow. Do not ask what the code answers.
2. Ask the developer once, with a recommendation for each:
   - Chat summary on? Recommend yes; it replaces the fixed message window.
   - Notes about the user across chats? If yes: browser (no backend work,
     one device) or database (recommended when the app has one).
   - Notes shared by the users of a tenant? Database only. If yes: who may
     write them (everyone, or a role), and whether each change needs a
     confirmation in the chat (default yes).
   - Auto-compact threshold: keep the default, or a fixed token budget or a
     share of the context window. See Auto-compact below.
3. Database chosen: add the table from
   [references/sql-schema.md](references/sql-schema.md) with the app's
   migration workflow, then copy the matching store:
   [Drizzle](references/store-drizzle.md), [Prisma](references/store-prisma.md)
   or [plain SQL](references/store-sql.md). For another database or ORM,
   implement the three methods of `MemoryStore` (`list`, `add`, `remove`)
   against the same columns. An app with row level security or a tenant
   column on every table adapts the schema to its own conventions; the
   contract is the three methods, not the table.
4. Add the store test from [references/store-test.md](references/store-test.md)
   and run it against the development database. `verifyMemoryStore(store)`
   must pass; pass `{ authorId }` with a real user id when the author column
   is a foreign key.
5. Configure the handler (see Configuration). `scope` returns the user id and
   the tenant id of the verified session.
6. Browser notes chosen: pass a `createLocalMemoryStore` to the chat
   transport (see Configuration). The storage key must contain the tenant and
   user identity, like the chat session store.
7. Give `memory_remember` and `memory_forget` labels in the app's language
   where the chat UI labels tools, and labels for the `note` and `scope`
   fields where it renders approval cards.
8. Verify in the running app (see Verification), then report what was set up,
   the table the developer has to apply in production and the threshold in
   effect.

## Configuration

```ts
import { createAiChatHandler } from 'glirastes/server/nextjs';

createAiChatHandler({
  // ...
  memory: {
    model: fastModel,                       // writes summaries; default: the chat model
    chat: { autoCompact: 8000 },            // or 0.3, or 'off'; omit for the default
    user: { store },                        // `true` keeps user notes in the browser
    shared: { store, canWrite: (request) => isAdmin(request) },
    scope: (request) => ({ user: session.userId, shared: session.tenantId }),
    onError: (error) => log(error),
  },
});
```

- With `memory` set, the handler no longer cuts the history at
  `maxContextMessages`; the summary threshold bounds the context instead.
- `chat: false` turns the summary off, omitting `user` and `shared` turns
  notes off. `memory: {}` is the chat summary alone.
- `shared.approval: false` lets shared notes change without confirmation;
  keep the default unless the developer decides otherwise.
- Limits: a note has at most 240 characters; 20 user notes and 30 shared
  notes by default (`maxNotes`).
- A store that throws does not fail the chat: the turn runs without those
  notes and `onError` gets the error.
- Types for the app's own wrappers: `ChatMemoryConfig`,
  `ChatCompactionOptions` (the `chat` object) and `MemoryScopeKeys` (what
  `scope` returns), all from `glirastes/server/nextjs`.
- `createInMemoryMemoryStore()` is a process-local `MemoryStore` for unit
  tests and a single development process; never use it in production.

Browser notes, with the React transport:

```ts
import { createLocalMemoryStore, useVercelAiChatTransport } from 'glirastes/react';

const memory = useMemo(
  () => createLocalMemoryStore({ storageKey: `app:memory:${tenantId}:${userId}` }),
  [tenantId, userId],
);
const transport = useVercelAiChatTransport({ /* ... */ memory });
```

`createLocalMemoryStore` returns a `BrowserMemoryStore` (`read`, `write`);
an app with its own client storage implements that interface instead.

## Auto-compact

The summary starts when the estimated tokens of the conversation history
pass a threshold. Resolution order:

1. `memory.chat.autoCompact` in code,
2. the environment variable `GLIRASTES_AUTOCOMPACT`,
3. the default: 8000 tokens, at most 30 % of the model's context window.

A value up to `1` is a share of the context window (`0.3`), a larger one a
token count (`8000`), `off` disables. The context window comes from the
model id (`contextWindowOf(model)` shows what the SDK assumes); set
`memory.chat.contextWindow` for a model it does not know (it then assumes
128000). To let operations tune the threshold per
environment, leave `autoCompact` out of the code and name the variable in the
deployment documentation; never set its value yourself.

The threshold counts the history only. System prompt, tool definitions and
tool steps of the current turn are not part of it, so keep it well below the
context window.

## Commands

```bash
# after wiring the handler, the derived tools must still be current
glirastes tools refresh
glirastes tools check
glirastes doctor
```

## Verification

- The store test passes against the development database.
- In a chat longer than the threshold, a fact from the first message is still
  answered correctly, and the stored assistant messages carry a
  `data-memory-summary` part.
- "Remember that ..." stores a user note; a new chat of the same user knows
  it; another user does not.
- A shared note asks for confirmation, is stored after it, and a second user
  of the same tenant sees it. A user of another tenant does not.
- "Forget ..." removes the note; the confirmation shows the note text.
- `glirastes tools check` passes.
