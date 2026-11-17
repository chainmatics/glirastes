# Protected-text privacy profile

`privacy` on `createAiChatHandler` (`glirastes/server/nextjs`) protects
personal data in every model call of a chat turn. All names below come from
`glirastes/server`.

## Contents

- What it guarantees
- Setup
- Screenshots
- Tools, approvals and idempotency
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
      return user && chat.conversationId
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
  Defaults: 1 h idle, 24 h absolute. An expired mapping starts a new
  generation; a deleted one (`deleteMapping`) stays deleted.
- `knownIdentities` (`KnownIdentity`) registers the signed-in user and
  people the principal may see. Full names, "Last, First", name parts of
  four or more letters (any case), e-mails and ids are then protected
  deterministically. People in JSON tool results are registered
  automatically (`extractIdentitiesFromJson`).
- The local pipeline's classifier gets the boundary through
  `PipelineCallOptions.wrapModel`; a protected call never learns or stores
  the turn's text.
- `privacy` replaces `piiShield`. It cannot be combined with `lancer` or
  `telemetry`, and a `pipeline` must be the local one, not the remote Pro pipeline.
- The client must send the chat id (`body.id`; `useChat` does). Without a
  scope the handler answers 401.
- `providerLabel` names the model in the status line. `providerOptions`
  (`ProviderOptionsAllowlist`, default `DEFAULT_PROVIDER_OPTIONS_ALLOWLIST`)
  lists the content-free provider options that may pass.

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

## Tools, approvals and idempotency

- `wrapToolsForPrivacy` (applied by the handler) rehydrates the model's
  pseudonyms to the originals of this scope before `needsApproval` and
  `execute`. The backend still authorizes the final values with the user's
  own credentials. A pseudonym is never an authority.
- The approval shown to the user, and bound by the handler, carries the
  originals the user saw.
- A thrown tool error reaches the model as `tool_failed` only.
- `receipts` (`ToolReceiptStore`, e.g. the Postgres runtime store) makes a
  tool call id execute once. A timeout leaves the outcome unknown
  (`privacy_tool_outcome_unknown`) and is not retried blindly. Receipts hold
  no originals and no digest of them.

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
against deliberately hidden code.

`PrivacySession` (from `shield.open`, backed by a `PrivacyMappingStore`) exposes `pseudonymizeText`, `pseudonymizeJson`,
`rehydrateText` and `rehydrateJson`. `PrivacyBoundary.wrapModel` refuses a
model id string or a model of another boundary.

## Errors and diagnostics

- HTTP refusals carry `{ error: <code> }` only: 400 invalid scope, 401 no
  scope, 403 blocked attachment, 409 deleted mapping, 422 missing
  capability, 503 for detector, store or key outages.
- `onError` and `onToolError` receive `privacySafeError(error)`: name, code
  and a numeric provider status, never a message. Use `toSafeError` for
  your own logs.
- A custom `streamHandler` gets the wrapped model and `ctx.privacy`; it must
  pipe its UI stream through `projectUiMessageStream` before
  `bindApprovalRequests`.

## Limits

- Free-text names the app does not know and the local detector does not find
  are not protected. Register the people the user works with.
- Short name parts (three letters) match their exact case only.
- An original equal to a pseudonym already used in the conversation stops
  the turn (`privacy_mapping_conflict`).
- Screenshots in `allow-original` mode are not pseudonymized.
- Speech must be transcribed locally before it enters the chat.
