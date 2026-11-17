# Protected-text privacy profile

`privacy` on `createAiChatHandler` (`glirastes/server/nextjs`) protects
personal data in every model call of a chat turn. All names below come from
`glirastes/server`.

## Contents

- What it guarantees
- Setup
- Screenshots
- Model providers
- Tools, approvals and idempotency
- Conversation history and context loss
- Model calls outside the chat handler
- Errors and diagnostics
- Limits

## What it guarantees

- One boundary per turn wraps the resolved model (`createPrivacyBoundary`,
  an AI SDK V3 middleware). It protects the system prompt in both forms, the
  whole history, tool calls and results, tool schemas, the response format
  and stop sequences, for every step, retry and the pipeline classifier.
- Originals become stable pseudonyms of one `PrivacyScope` (tenant, app,
  environment, principal, conversation). Other principals or conversations
  cannot resolve them.
- The model and the server-side result keep pseudonyms. Only the UI stream
  of the scope's principal is rehydrated (`projectUiMessageStream`).
- Every failure stops the turn with a content-free `PrivacyError`
  (`PrivacyErrorCode`, `isPrivacyError`). Nothing is sent unprotected, and
  a failure never counts as "nothing found".
- Generated text that contains a protected original is stopped
  (`privacy_output_leak`) before any part of it reaches the browser.

## Setup

```ts
import { createAiChatHandler } from 'glirastes/server/nextjs';
import {
  createPostgresPrivacyMappingStore,
  createStrictPiiShield,
  parsePrivacyKeyring,
} from 'glirastes/server';

const store = createPostgresPrivacyMappingStore(sql, {
  keyring: parsePrivacyKeyring(process.env.PRIVACY_MAPPING_KEYS),
});
await store.initialize();
const shield = createStrictPiiShield({ store, locale: 'de-DE' });

export const POST = createAiChatHandler({
  // ...
  privacy: {
    shield,
    scope: async (req, chat) => {
      const user = await auth(req);
      return user
        ? { tenantId: user.tenantId, appId: 'my-app', environment: 'prod', principalId: user.id, conversationId: chat.conversationId }
        : null;
    },
    knownIdentities: async (req) => [{ id: user.id, name: user.name, email: user.email }],
    attachments: async () => ({ app: 'blocked' }),
    modelCapabilities: (model) => ({ images: false }),
  },
});
```

- `createStrictPiiShield` (`StrictPiiShieldConfig`, `StrictPiiShield`,
  `PROTECTED_TEXT_PROFILE`) refuses a non-persistent store and a remote
  detector. `createMemoryPrivacyMappingStore` is for tests only.
- `createPostgresPrivacyMappingStore` keeps the mapping in the app's own
  Postgres (`POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL`, also shipped as a
  migration). Values are AES-256-GCM sealed with the scope as associated
  data. The keyring (`PrivacyKeyring`, JSON
  `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"},"index":"<base64>"}`)
  is a deployment secret outside the database. To rotate, add a key, make it
  active, run `rewrapEntries()` until it returns 0, then remove the old key.
  Defaults: 1 h idle, 24 h absolute. An expired or lost mapping starts a new
  generation, a fresh random id that is never reused; a deleted one
  (`deleteMapping`) stays deleted. After either, the model no longer gets the
  older messages (see "Conversation history and context loss").
- `knownIdentities` (`KnownIdentity`) registers the signed-in user and
  people the principal may see. Full names, "Last, First", name parts of
  four or more letters (any case), e-mails and ids are then protected
  deterministically. People in JSON tool results are registered
  automatically (`extractIdentitiesFromJson`); a result the walk cannot
  finish stops the turn. `identitiesFromToolResults` takes a function
  `(toolName, output) => KnownIdentity[]` for result shapes the walk does not
  know, or `false` to turn it off.
- The local pipeline's classifier gets the boundary through
  `PipelineCallOptions.wrapModel`; a protected call never learns or stores
  the turn's text. It sees the admitted history only, and its prompt is
  built from text this turn already protected (`protectedPrompt`).
- `privacy` replaces `piiShield`. It cannot be combined with `lancer` or
  `telemetry`, and a `pipeline` must be the local one, not the remote Pro pipeline.
- The client must send the chat id (`body.id`; `useChat` does). A request
  without one is refused with 400 `privacy_scope_invalid` before `scope` runs,
  so conversations never share a mapping. Without a scope the handler
  answers 401.
- `providerLabel` names the model in the status line. `providerOptions`
  (`ProviderOptionsAllowlist`, default `DEFAULT_PROVIDER_OPTIONS_ALLOWLIST`)
  lists the content-free provider options that may pass. Their values must be
  flags, numbers or short enum tokens (`low`, `ephemeral`, `1h`); free text
  stops the call with `privacy_provider_option_blocked`.

## Screenshots

`attachments` returns an `AttachmentPolicyInput`: app ceiling, optional
tenant rule and the user's choice (`ScreenshotMode`: `blocked` or
`allow-original`). `resolveAttachmentPolicy` takes the most restrictive one,
so a browser flag never widens the app or tenant rule. Default: `blocked`.

- `blocked`: a screenshot in the new message is refused with 403
  `privacy_attachment_blocked`; older files are withheld from the model.
- `allow-original`: inline PNG, JPEG, WebP or GIF reach a vision-capable
  model (`ModelCapabilities.images`) unredacted, and the status line says
  "Text geschützt; Screenshots werden im Original übertragen". PDFs, audio,
  SVG and remote URLs stay withheld. A text-only model answers 422
  `provider_capability_missing`.
- Keep `attachments: { enabled: true }` on the handler for the format checks.

## Model providers

`providers` makes the model interchangeable without touching the shield.
`createProviderRegistry` (`ProviderRegistryConfig`) returns a `ProviderRegistry` of server-side
entries (`ProviderEntry`: adapter, model id, secret reference, endpoint,
capabilities, who may select it):

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

const registry = createProviderRegistry({
  adapters: [
    openRouterAdapter({ createOpenAI, routing: { only: ['anthropic'] } }),
    anthropicAdapter({ createAnthropic }),
  ],
  entries: [
    { id: 'standard', label: 'Standard', adapter: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', secretRef: 'OPENROUTER_API_KEY' },
    { id: 'direct', label: 'Anthropic direkt', adapter: 'anthropic', modelId: 'claude-sonnet-4-5', secretRef: 'ANTHROPIC_API_KEY', capabilities: { images: true } },
  ],
  defaultEntry: 'standard',
  secrets: (ref) => process.env[ref],
});

privacy: { /* ... */ providers: { registry, selection: (req, scope) => loadUserChoice(scope) } }
```

- The browser lists `registry.options(scope)` (`ProviderOption`: id, label,
  capabilities). The user's choice is that id. It is never a URL, key or
  model string.
- `registry.resolve` (`ResolvedProvider`) runs once at the turn's start.
  The resolved model replaces the handler's `model` for the whole turn and
  is wrapped by the same boundary. A change applies from the next turn.
- An unknown or foreign choice, or an unqualified adapter, stops the turn
  with 403 `provider_not_allowed`. A missing secret stops it with 503
  `provider_unavailable`. There is no fallback provider.
- `openRouterAdapter` merges `OpenRouterRoutingPolicy` into the `provider`
  field of every request body (`withOpenRouterRouting`). The default
  `STRICT_OPENROUTER_ROUTING` is no fallbacks, `data_collection: 'deny'`
  and `zdr: true`, and a request cannot weaken it. `anthropicAdapter` and
  `openAiCompatibleAdapter` send no OpenRouter fields.
- Adapters take the provider factory (`CreateOpenAIProvider`,
  `CreateAnthropicProvider`), so the SDK adds no provider dependency. A
  custom `ProviderAdapter` builds a model from `ProviderModelInput`; it
  needs `qualified: true`, which it may claim only after it passes the
  provider conformance tests.

## Tools, approvals and idempotency

- `wrapToolsForPrivacy` (applied by the handler) rehydrates the model's
  pseudonyms to the originals of this scope before `needsApproval` and
  `execute`. The backend still authorizes the final values with the user's
  own credentials. A pseudonym is never an authority.
- The approval shown to the user, and bound by the handler, carries the
  originals the user saw.
- A thrown tool error reaches the model as `tool_failed` only.
- `receipts` (`ToolReceiptStore`, e.g. the Postgres runtime store) records
  every write of a protected turn:
  - A call resumed from an approval is keyed by the signed approval id. One
    approval runs at most once in its mapping generation, also when the
    request is replayed. Only the first call of the approved tool under that
    call id uses the approval; a later call reusing the id is a new call.
  - A call the model makes is keyed by request, call id and input. Within one
    request the same call runs once. A new request is a new call, also a
    network retry or `regenerate`: receipts do not deduplicate those.
  - A provider that reuses call ids (`call_0`) across turns still runs each
    new call.
  - A new generation is a new key namespace.
- A write whose effect the answer does not tell leaves the outcome unknown:
  timeout, abort, a connection lost after sending, an answer that cannot be
  read, and a 408, 502 or 504 answer to a write. The receipt stays pending and
  the call fails as `privacy_tool_outcome_unknown` (not `tool_failed`), with a
  hint not to repeat it. A replay of the same approval gets the same answer
  instead of a second run. Check the backend before asking the user to repeat
  it. Only the core sets this state (a marker no backend payload can carry).
- Receipts hold no originals and no plain digest of them; the input
  fingerprint is keyed with the scope's secret.
- An approval that belongs to an expired or deleted generation cannot be
  resumed (409); the user asks again and approves the new request.

## Conversation history and context loss

The browser sends the whole chat history with every request, so the
handler cannot take it at face value. It admits to the model only history
this server released in the current mapping generation:

- When a user message is accepted and when an answer stream ends (or is
  cancelled), the handler binds each message to its role, its parts (text,
  tool call with id, input and outcome, approval id) and its predecessor with
  a keyed HMAC over scope and generation (`history-binding.ts`). Message ids
  from the client are not trusted. A swapped role, a spliced part, a tool
  result moved to another call, a reordered, duplicated or edited message
  and a client-made summary all break the chain.
- The model gets the last unbroken run of bound messages plus the new user
  message; every text part of it passes the full protection path before it
  is bound. Everything before the break is withheld. Model and classifier get
  each message as id, role and the bound fields of its parts only: fields
  the client adds or changes outside the binding (`content`, `metadata`,
  extra part fields) never reach a model. Reloads (`useChat`, also with an open approval that
  `sanitizeStoredMessages` removed), renamed message ids, concurrent tabs and
  a server restart over the same store keep working.
- The binding attests what the server released into the response stream, not
  what the browser received. A cancelled or cut-off stream binds the part
  that was released; a later request may continue from it. An answer longer
  than 4 MiB of stream text is not bound (the next turn withholds it).
- Bindings are stored per mapping generation and end with it; a long
  conversation adds one or two rows per turn.
- A continuation (approval response, tool result) of a message that is not
  bound in this generation is refused with 409 `privacy_mapping_expired`,
  without a model call, on every later attempt. Fresh requests and new
  approvals work.
- The binding protects against manipulated history. It does not replace
  detection or the egress check: admitted history is still pseudonymized
  like new input.

**Context loss is visible product behaviour.** After the mapping expires
(defaults 1 h idle, 24 h absolute), is lost or is deleted, the chat window
still shows the whole history, but the model no longer gets the older
messages. The turn's `data-privacy-status` part then carries
`historyWithheld` (count) and `historyNotice` ("Frühere Nachrichten dieses
Chats werden vom Assistenten nicht mehr verwendet. Bitte relevante Angaben
erneut nennen."). Show that notice next to the answer. The model gets a
matching note and asks for details again instead of guessing. Old answers
are never re-read as new input: their pseudonyms would map to nothing.

The defaults fit a working session: an hour of inactivity or a day of use
ends the model's memory of the chat, not the chat. A longer TTL would keep
originals and pseudonyms linked longer and is not recommended.

## Model calls outside the chat handler

Wrap every other model call of the app (drafts, filters, summaries) with a
boundary of the request's scope:

```ts
const session = await shield.open(scope);
await session.registerIdentities(identities);
const boundary = createPrivacyBoundary({ session });
const result = await protectedGenerateText({ model, prompt }, boundary);
const shown = session.rehydrateText(result.text);
```

`protectedStreamText`, `protectedGenerateText` and `protectedGenerateObject`
take a `ModelCallProtection` (the boundary) or an explicit `null` for a call
that is deliberately outside the profile. They refuse a protection that
returns the model unwrapped.

### Egress check

`glirastes/codegen` ships the check the SDK runs in CI. It finds every
model call, provider import, computed import and network primitive
(`fetch`, `WebSocket`) in a source tree, also through aliases, namespaces
and `import()`, and compares them with a reviewed inventory:

```ts
import { checkEgressInventory, EgressInventorySchema, scanTreeForEgress } from 'glirastes/codegen';

const inventory = EgressInventorySchema.parse(JSON.parse(readFileSync('privacy-egress-inventory.json', 'utf8')));
const violations = checkEgressInventory(scanTreeForEgress(process.cwd(), { include: ['src'] }), inventory);
if (violations.length > 0) process.exit(1);
```

Each inventory entry (`EgressInventoryEntry`, schema `EgressInventoryEntrySchema`) names file, symbol,
kind (`EgressKind`), decision (`facade`, `protected`, `exception`,
`content-free`) and a reason. A new unreviewed site fails with an
`EgressViolation` such as `unapproved_model_call`; an entry whose site is
gone fails as stale. `scanSourceForEgress` checks one file; `ScanTreeOptions`
narrows the tree; `MODEL_CALL_SYMBOLS` lists the `ai` calls it treats as
model egress. `EgressFinding` and `EgressInventory` are the result and file
types. The check guards against accidental bypasses; it is not a proof
against deliberately hidden code. It verifies that every site is listed
with an expected count, not that its decision is true: whether a
`protected` site really passes the boundary is the reviewer's call and the
job of tests.

`PrivacySession` (from `shield.open`, backed by a `PrivacyMappingStore`) exposes `pseudonymizeText`, `pseudonymizeJson`,
`rehydrateText` and `rehydrateJson`. `PrivacyBoundary.wrapModel` refuses a
model id string or a model of another boundary.

## Errors and diagnostics

- HTTP refusals carry `{ error: <code> }` only: 400 invalid scope, 401 no
  scope, 403 blocked attachment, 409 deleted or expired mapping and
  pseudonym conflict, 422 missing capability, 503 for detector, store or key
  outages.
- `onError` and `onToolError` receive `privacySafeError(error)`: name, code
  and a numeric provider status, never a message. Use `toSafeError` for
  your own logs.
- An answer stream that ends inside an unfinished part (provider cut off)
  does not release the held text; it ends with `privacy_output_incomplete`.
- A custom `streamHandler` gets the wrapped model and `ctx.privacy`; it must
  pipe its UI stream through `projectUiMessageStream` before
  `bindApprovalRequests`. Only an SSE UI message stream
  (`text/event-stream`) is bound as history; any other response is not, so
  the model will not see that answer in the next turn.

## Limits

- Free-text names the app does not know and the local detector does not find
  are not protected. Register the people the user works with.
- Short name parts (three letters) match their exact case only.
- An original equal to a pseudonym already used in the conversation stops
  the turn (`privacy_mapping_conflict`), also when two turns race. The
  conversation recovers by starting a new chat (new chat id) or after the
  mapping is deleted; there is no silent remapping.
- Dates: only a date of birth is protected. It is recognised by a birth
  field (`birthDate`, `geburtsdatum`, `dob`, also inside longer names such as
  `patientBirthDate` or `birth_date_iso`) or by a birth word up to three
  words before it ("geboren am Montag,", "Geburtsdatum des Kunden:",
  "geb.-Dat.:", "born"). Once known, the same date is protected wherever it
  appears again. Formats: `DD.MM.YYYY`, `D.M.YYYY`, ISO and
  "12. Dezember 1976" / "12 December 1976"; a pseudonym is written back in the
  format the model used.
- A date after a birth word in another form ("15.01.80", "01/15/1980",
  "Dec 12, 1976") stops the turn with `privacy_unsupported_content` instead
  of being sent; so does such a birth field. A tool input that mentions a
  protected date in such a form is refused too.
- Appointments, deadlines and other dates go to the model as plain text. A
  date of birth without a birth word or field ("* 01.01.1980", a bare date in
  a table) is not detected. A date near a birth word, such as a birthday
  party, is pseudonymized like a date of birth and mapped back.
- OpenAI replay references (`itemId`, encrypted reasoning) are stripped from
  history. Anthropic thinking signatures in history are refused
  (`privacy_provider_option_blocked`), so extended thinking with tools is
  not supported in the profile.
- Screenshots in `allow-original` mode are not pseudonymized.
- Speech must be transcribed locally before it enters the chat.
