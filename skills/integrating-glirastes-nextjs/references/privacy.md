# Pseudonymization (opt-in protected-text profile)

The Apache-2.0 SDK leaves ordinary chat unchanged without explicit activation.
Local `privacy.policy.required: true` on `createAiChatHandler`
(`glirastes/server/nextjs`) activates self-managed pseudonymization.
Configuration alone is not proof of managed protection. The managed Platform
**PII-Schild** is a Business/Enterprise feature; a signed protected policy
always requires enforcement, even with local `required: false`.
An inactive configuration does not open mappings, require keys or inspect providers. All names below come from
`glirastes/server`.

## Contents

- What it guarantees
- Setup
- Screenshots
- Model providers
- Tools, approvals and idempotency
- Conversation history and context loss
- Model calls outside the chat handler
- Platform-governed policy
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
    policy: { required: true },
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
The rule only narrows the effective policy: originals need `allow-original`
in the signed block or, without one, in `policy.screenshots.mode`
(see "Platform-governed policy").

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

## Platform-governed policy

A connected app can let the Glirastes Platform decide the profile. The
signed policy revision then carries a `privacy` block (`PrivacyPolicyBlock`;
`isProtectedPolicy` tells the protected form, `ProtectedTextPolicyBlock`,
from an explicit `off`): screenshot mode, approved providers, mapping
lifetimes and speech limits. A turn pins it with its snapshot. Local
configuration may only tighten it: `mergePrivacyPolicy` takes the stricter
screenshot mode, intersects image types and providers and keeps the shorter
lifetimes (`EffectivePrivacyPolicy`, its `localRestrictions` name what the
app tightened as `PrivacyLocalRestrictionCode`).

```ts
const glirastes = createGlirastes({
  generated,
  stateEnvironmentId: process.env.GLIRASTES_STATE_ENVIRONMENT_ID,
  stateStore: environmentId => new FileRuntimeStateStore(`/persistent/runtime-${environmentId}.json`),
  // GlirastesPrivacyOptions: lets the runner enforce and report a signed block.
  privacy: { managed: true, shield, providers: registry, local: { mapping: { idleTtlSeconds: 1800 } } },
});

export const POST = createAiChatHandler({
  ...(await glirastes.chatTurn(principalFor)),
  privacy: {
    shield, scope, knownIdentities,
    providers: { registry },
    policy: { mapping: { idleTtlSeconds: 1800 } }, // LocalPrivacyPolicy
    onDecision: (code) => counters.increment(code),  // PrivacyDecisionCode
  },
});
```

- `policy` (`LocalPrivacyPolicy`) is the app's own floor. `required`
  defaults to false; explicit `required: true` keeps pseudonymization on
  when the Platform publishes `off` or nothing. Without a signed block the local values apply
  (`PRIVACY_LOCAL_DEFAULTS`: 1 h idle, 24 h absolute, 60 s speech), exactly
  as the reported effective digest says: screenshots stay blocked unless
  `policy.screenshots.mode` is `allow-original`, `providerEntryIds` narrow
  the registry's offer and `openRouterOnly` the upstream providers. The
  `attachments` rule only narrows that further; on its own it never opens
  originals. Missing/false does not weaken a signed protected policy.
  For managed bootstrap, set `privacy.managed: true` on `createGlirastes`;
  this waits for current authenticated authority without forcing a local profile.
- Approvals name an entry id and the digest of its non-secret binding
  (`ProviderBinding`: adapter, protocol, endpoint, model, routing, image
  capability; `normalizeProviderEndpoint`). Re-pointing an entry at another
  endpoint, model or routing changes the digest, so the old approval no
  longer applies and the turn is refused with `provider_not_allowed`;
  rotating a key does not. An adapter without a binding is never approved.
  Under a signed list every model of the turn must be the one the registry
  built for it: the boundary refuses any other model before a request.
- The OpenRouter adapter replaces the `provider` field of every request
  with exactly the bound routing (`only`, no fallbacks, `data_collection:
  'deny'`, `zdr`); routing options set to `undefined` or to weaker values,
  and provider fields a request carries, change nothing on the wire.
- In a protected turn with `providers`, a pipeline's intent classifier runs
  on the turn's resolved, approved model through the SDK; the classifier
  model and `generateText` callback configured on `createLocalAiPipeline`
  are not used for it.
- Report the entries the Platform may approve in `.glirastes/tools.json`:
  `"privacyProviders": [{ "id": "standard", "label": "Standard", "binding": <registry.bindingOf('standard')> }]`.
  Setup writes only id, label, adapter and binding digest into the setup
  artifact (`PrivacyProviderReport`), never a URL, model id or key name.
  `createGlirastes` names every entry whose registry binding differs from
  the artifact through `onError`; run setup again after such a change.
- The runner reports a content-free `PrivacyRuntimeStatus` in its heartbeat
  (`enforced`, `refused`, `downgrade-rejected`) and the block versions it
  supports. A protected block it cannot enforce (no `privacy`, no matching
  binding, unusable default) is reported as `privacy_refused` and rejected
  (`PrivacyRefusedError` in `glirastes/sync`). Every turn then answers 503
  `privacy_not_configured` instead of running unprotected on the previous
  revision, and the verified requirement raises the privacy floor:
  withdrawing or revoking it does not lead back to an unprotected revision.
  Traffic resumes only with a protected revision this runtime can enforce,
  or a newer, explicitly signed `off`. A candidate with an invalid signature
  never refuses or raises anything. The floor is a high-water mark of the
  accepted revision number: a rollback, a replayed older `off`, a rejected
  revision, a dropped connection or a failed save never lowers it.
- Once a protected block was accepted or refused, a later revision without
  one is refused (`privacy_policy_downgrade`); only a newer, explicitly
  signed `off` lowers the floor. The gate runs again before every model
  step and tool call, also the one an approval resumes: a refusal or a
  revocation of the pinned revision (`privacy_policy_revoked`) arriving
  during a turn stops the next call, so no result of a running tool reaches
  the model after the lock. A custom `streamHandler` must await
  `ctx.beforeModelStep?.()` first in `prepareStep`, as the built-in one does.
- Managed privacy needs durable state. Explicit `privacy.managed: true`
  or `privacy.local.required: true` opts into fail-closed bootstrap.
  A verified signed privacy block or retained authority also binds the runner;
  a generic state store or provider metadata alone does not activate protection. Pass `stateStore: (environmentId) => new FileRuntimeStateStore(path)`
  (`glirastes/sync`, one file per environment, on a persistent volume) and
  `stateEnvironmentId` (or `GLIRASTES_STATE_ENVIRONMENT_ID`). This nonsecret UUID
  comes from the selected environment's Citadel connection block; environment-bound
  CLI pairing writes it too. App-wide pairing preserves an existing binding.
  The SDK reads this store before network discovery. Keep both the binding and
  store when removing local activation: retained signed authority still applies.
  A live connection mismatch fails with `privacy_state_binding_mismatch`; align
  the intended environment through Connect rather than deleting the store.
  Removing/changing both store and binding erases local authority and is an
  explicit administrator/DR trust boundary, not a supported privacy downgrade.
  Without a durable store (none, or `MemoryRuntimeStateStore`) the runner
  claims no `privacyPolicyVersions` capability and refuses a protected block
  with the reason `accepted_state_missing`; it never reports it as applied.
- Until a verified sync was saved durably, a managed runner answers 503
  `privacy_policy_unavailable` to chat turns, `privacyPolicy()` and
  `speechPolicy()`. That covers a new or lost state, a Platform that is
  unreachable at start (the `ready()` timeout releases nothing: the
  fixed store is loaded before the lookup; live freshness still needs sync), an unreadable
  state file (reported as `RuntimeStateUnreadable`, retried, never
  overwritten with defaults) and a failed save (blocked until a later
  verified state was saved). A lost state has no local floor: the first
  verified answer of the Platform decides.
- A runner without explicit activation or verified privacy authority works
  as before: it claims no privacy capability, and a protected block is
  refused, never applied.
- With `metrics` on the handler, decisions under a policy are also counted
  as content-free `privacy.decisions` events (codes from
  `PRIVACY_DECISION_CODES`, windows of at most 60 s, a bounded buffer that
  drops and counts the oldest windows). A rejected batch never changes
  enforcement. The counts show protected calls that were reported, not that
  no other path sent content.
- Speech: pass `policy: () => glirastes.speechPolicy()` to
  `createRecordingTranscriptionHandler` (`SpeechPrivacyPolicy`). It is read
  per request; a protected policy forces a private service address and caps
  the duration. Only an explicit `'off'` (what `speechPolicy()` returns when
  no protected policy applies) leaves the recording unprotected; `null`,
  `undefined`, a throw or a malformed value answers 503. `speechPolicy()`
  throws the same `PrivacyError` a chat turn would. Route every audio input
  (cloud and WebSocket routes included) through this policy.

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

Effective `privacy` protection disables result handles and SDK result-reader execution, even with `resultHandles: true`. Oversized protected output is visibly withheld (`outputWithheld`); narrow a read request instead of retrying a write. The ordinary off profile retains result retrieval.

## Current port boundaries

Protected turns refuse mention markers and direct composer commands with
HTTP 503 `privacy_unsupported_content` and a named feature. Enter plain text
instead. Browser canonicalization can shorten identity labels before the
server sees them; these fragments are not asserted to be protected.
The `onModelInput` content debug hook is disabled in protected turns.
Protected history uses complete admitted messages and does not generate
compacted identity summaries or seen-object memos. Generic tool failure
details are withheld before any text clipping. Ordinary off behavior retains
these features. The Node HTTP bridge delegates to this same protected handler.
At fixed base f29b3607 view-context is a contract only; arbitrary request
view-context fields are not consumed as model context.

For the GID Stage 1 delivery, speech is blocked when protection is effective.
Existing cloud speech remains available only in ordinary off mode. The
previous consumer Whisper deployment is a separate follow-up, and upstream
SDK local STT is not evidence of deployed or qualified consumer speech.

Tool middleware is currently unavailable in protected turns: the handler returns `503 privacy_unsupported_content` with `feature: middleware` before middleware, tools or model calls. Ordinary unprotected calls retain middleware behavior. Delayed middleware execution needs a separate authorization boundary before it can be supported.

Server approval-subject/list/preview lookups are not yet supported under pseudonymization. A protected handler with such declarations returns `503 privacy_unsupported_content` before model calls or backend reads. Ordinary approvals without subject lookups keep the scoped receipt flow; ordinary unprotected subject lookups are unchanged. Do not disable required approval checks to work around this boundary.
