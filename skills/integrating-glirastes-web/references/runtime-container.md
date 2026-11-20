# Configured runtime service (0.14, V1)

Use this path when a non-Node backend needs Glirastes without customer Node
server code. A suitable existing Node/Next.js server can instead embed
`createAiChatHandler` from `glirastes/server/http`; `/server/nextjs` remains
compatible. The container is one independent service per application and
environment. It is not a sidecar per backend replica and does not offer HA.

The official public Linux amd64 image is
`ghcr.io/chainmatics/glirastes-runtime:0.20.0`; pulling needs no registry login.
For this release, the verified immutable image reference is:

```sh
export GLIRASTES_RUNTIME_IMAGE=ghcr.io/chainmatics/glirastes-runtime@sha256:6a180c90ae923566d357eb15f1297640cba57c24bc49e3a8d2baad514335d925
docker pull "$GLIRASTES_RUNTIME_IMAGE"
```

Use the exact matching SDK version (0.20.0 for this image) for artifact builds
and browser code. Do not substitute a newer CLI merely because it is available.
The [PHP Compose example](https://github.com/chainmatics/glirastes/tree/v0.20.0/examples/php-runtime)
and [browser host examples](https://github.com/chainmatics/glirastes/tree/v0.20.0/examples/frontend-frameworks)
are runnable references. PHP has real API/approval tests; Angular/SvelteKit/Nuxt
have browser host tests. Neither establishes a full Rust/Java stack acceptance.

## Customer inputs and build

Keep the existing backend and its authorization. Export its authoritative API
as committed **OpenAPI 3.0 or 3.1 JSON** and add the normal SDK inputs. Generate a unique
UUID for the app once and use the same value in both files below; preserve an
existing appId. Example `.glirastes/tools.json` (replace this example appId):

```json
{
  "schemaVersion": 1,
  "appId": "3e0e58e8-1480-4c59-b173-63b45927d031",
  "targetAppKey": "customer-app",
  "locale": "en-US",
  "sources": [{ "kind": "openapi", "document": "api/openapi.json" }]
}
```

Example `.glirastes/prompt-bundle.json`:

```json
{
  "schemaVersion": 1,
  "appId": "3e0e58e8-1480-4c59-b173-63b45927d031",
  "artifactRef": "local://customer-app/prompts",
  "sections": {
    "planner": "Use available tools and ask when the target is unclear.",
    "appBehavior": "Help the signed-in user with this application.",
    "responseStyle": "Be concise and describe the observed result.",
    "capabilityFragments": {}
  }
}
```

An OpenAPI-only project needs no package.json. Browser actions/navigation use
supported scanner sources in addition to OpenAPI; a router bridge alone does
not discover pages. Do not add hand-written tools or edit generated artifacts.
Use the normal `tools resolve`, `tools describe` and policy workflow when the
generator reports gaps.

With the matching SDK CLI installed:

```sh
glirastes-runtime build --project /workspace/app --out /artifacts/release-1
glirastes-runtime validate --artifact /artifacts/release-1
# After committing generated outputs, CI verifies unchanged generation:
glirastes-runtime build --project /workspace/app --out /artifacts/ci-1 --frozen
```

The same commands run as arguments to the official runtime image. For example,
with `GLIRASTES_RUNTIME_IMAGE` set to the approved image digest and a writable
project bind mount:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace/app" \
  "$GLIRASTES_RUNTIME_IMAGE" \
  build --project /workspace/app --out /workspace/app/artifacts/release-1
```

The build writes `manifest.json`, `runtime.json` and `coverage.json` in a **new**
output directory. Runtime loads JSON only, checks exact SDK version, hash, app
identity and schema bindings. A hash detects corruption, not an untrusted
publisher. Review artifacts and deploy them read-only. Build-time changes do
not automatically update a running container. CI must also regenerate the
backend OpenAPI export and detect stale exports; frozen generation alone cannot
prove that a stale document matches the backend.

The supported subset is intentionally narrower than all OpenAPI 3.0/3.1: simple
path parameters (nullable parameters are unsupported), supported query parameters on GET/HEAD/DELETE, and JSON-object
bodies on POST/PUT/PATCH. Unsupported active operations fail the build, including
write-method query parameters, multipart, custom header/cookie arguments,
external/recursive references and unsupported schema/serialization features.
Declare authentication with `securitySchemes`, not model-supplied credentials.
Explicit `x-glirastes-ignore` and normal policy exclusions remain in coverage.
The build uses the generator's selection: with `"selection": "opt-in"` it
validates only operations marked `x-glirastes-tool: true`, and an operation
marked `x-glirastes-tool: false` is skipped in either mode; a selected
unsupported operation still fails the build.
OpenAPI `servers` does not select the API target.

## Identity contract

Configure a fixed endpoint on the backend origin, e.g. `/api/me`. It validates
the forwarded session cookie or bearer token and returns exactly:

```json
{"userId":"42","tenantId":"business-a","roles":["editor"]}
```

Invalid sessions return 401/403. Return no credentials or extra business data.
The runtime rechecks identity at tool boundaries. `tenantId` above is the
**business tenant**, separate from the SDK/platform tenant; the runtime maps
them and scopes the subject to business tenant plus user.

Every tool request forwards only selected user credentials and adds verified
`x-glirastes-business-tenant` and `x-glirastes-user-id` headers. **Backend
middleware must compare both with its current authenticated session and reject
mismatches.** They grant no access: retain existing record/tenant/role checks.
A confirmation never overrides backend authorization. No privileged service
account, browser-provided role mapping or OAuth token broker is introduced.

## Strict JSON configuration

Example `/etc/glirastes/runtime.json`; replace origins, model and paths with
reviewed deployment values. Unknown fields fail; JSON performs no environment
or shell interpolation. Secrets come from mounted files, never from the browser
or generated artifact.

```json
{
  "schemaVersion": 1,
  "server": { "publicOrigin": "https://app.example.com", "port": 8787 },
  "application": {
    "artifact": "/app/artifact",
    "apiOrigin": "http://backend:8080",
    "allowedPathPrefixes": ["/api"],
    "timeoutMs": 15000,
    "maxResponseBytes": 2097152,
    "maxResultChars": 16000
  },
  "identity": {
    "endpoint": "/api/me",
    "credential": { "type": "cookie", "names": ["session"] }
  },
  "model": { "name": "REPLACE_WITH_MODEL_ID", "apiKeyFile": "/run/secrets/model_key" },
  "approvals": {
    "secretFile": "/run/secrets/approval_key",
    "connectionStringFile": "/run/secrets/state_dsn"
  },
  "platform": { "enabled": false }
}
```

`application.maxResultChars` (optional, 1000 to 200000, default 16000) bounds
each successful tool result the model sees; an operation's
`x-glirastes-max-result-chars` wins for that tool. A larger result gets a
turn-scoped handle and an overview, and the model reads more with the built-in
`read_result`; `application.resultHandles: false` (optional, default on) cuts
it instead. `x-glirastes-output-allowed-fields`, `x-glirastes-output-denied-fields`
(`**.fileUrl` removes a key at any depth) and `x-glirastes-output-default-fields`
on an operation travel in the artifact too and are applied by the container: the
upper bound before anything is stored or shown, the default view in the first
answer.

Languages (all optional, section `chat`): `chat.locale` (BCP-47, default
English) is the language of the texts the runtime writes itself;
`chat.requestLocaleHeader` names a request header with the turn's language
(`accept-language` is read by preference, any other header holds one tag,
e.g. `x-app-language` sent by the chat's transport). With neither set, the
turn's language is the one the chat UI names in each request
(`Content-Language`, sent by the React/Vercel transport and
`<glirastes-chat>`; one BCP-47 tag, anything else ignored), else English;
`chat.locale` or `chat.requestLocaleHeader` replaces it: a fixed `chat.locale`
wins over the page language the chat sends, so set it only for a
single-language app. A language stored per user (the app's database) goes
into a header the chat's transport sends (`headers: { 'x-app-language':
user.language }`), named in `chat.requestLocaleHeader`; pass the same value as
the chat's `language` so its built-in texts match. `chat.locales` adds or
changes the runtime's own texts per language (`{"pl": {"closing": "...",
"silentTurn": "..."}}`, keys of the SDK handler's `locales`; partial tables
fall back per key, an unknown key fails at start). The artifact carries the
tool labels per language (`.glirastes/tools.json` `languages`, by default
en, de and every declared language; local, never sent to the Platform), and
the approval card and step display show them in the turn's language.

`chat.uiActionOutcomes` (`confirm` default, `report-only`, `off`) is the UI
action outcome protocol: with `confirm` a turn with a UI action takes two
POSTs (up to four with retries, so up to four times the per-request budgets);
a strict proxy in front must allow the body field `glirastesUiOutcomes`.
Only a request with that field gets the hand-off result shape
(`{ handedOff: true, … }`); every other request gets the 0.17.3 shape
`{ success: true, … }` (SDK default `uiToolResultShape: 'auto'`, not
configurable in the container).

`chat.history` (optional, strict: `toolTurnCounting` `all-turns` or
`tool-turns`, `seenObjects` `true` or `false`) changes how earlier turns reach
the model. Absent: the 0.18 SDK defaults (`tool-turns`, seen-objects memo on
for tools with `outputEntities`); `{"toolTurnCounting": "all-turns",
"seenObjects": false}` restores the 0.17 model input.

For bearer authentication use `"credential": {"type":"bearer"}`. For existing
backend CSRF middleware set `identity.csrfHeader` to `x-csrf-token` or
`x-xsrf-token` and send that header from the chat UI. Do not disable CSRF checks.
The default chat route is `/glirastes/chat`; the application ingress must route
it under the configured public origin and send the session cookie on that path.

The default model base URL is OpenRouter's OpenAI-compatible chat API; an
operator-controlled `model.baseUrl` is optional. A different backend URL or
model URL is an operator decision, never an input from a browser or tool call.

To connect an already authorized and paired app, replace `platform` with:

```json
{
  "enabled": true,
  "environment": "production",
  "apiKeyFile": "/run/secrets/glirastes_key",
  "requireAcceptedDeployment": true
}
```

Use `controlPlaneOrigin` only for a confirmed alternative platform origin.
The runtime will not become ready before an accepted deployment. A failed key
never silently enables standalone. An already accepted revision can survive a
transient platform outage; a cold restart waits for a fresh accepted revision.
Remote revocation is not instantaneous while the connection is unavailable.

## Deployment and verification

Run `glirastes-runtime serve --config /etc/glirastes/runtime.json`. The image
runs as nonroot UID 1000. Mount config/artifacts read-only and secret files with
appropriate readability. Use a read-only root filesystem, writable `/tmp` tmpfs,
dropped capabilities and restricted egress to the fixed backend, model provider,
PostgreSQL and optional platform. Runtime logs omit credentials and payloads.

PostgreSQL persists approval consumption and enforces one active runtime per
app/environment. All instances for that scope must use the same store. Use a
32+ character approval secret; keep it stable through pending approvals. The
store creates its own tables/indexes, so provide a restricted schema/search_path
and suitable initialization permissions. It is not a conversation database.

`/healthz` is liveness; `/readyz` checks dependencies and managed readiness.
The image healthcheck expects `/etc/glirastes/runtime.json`; override it for a
different config path. Disable ingress response buffering and automatic POST
retries. SIGTERM drains then aborts remaining work; allow a longer orchestrator
stop grace period. Stop the old instance before starting its replacement.

Keep browser conversations isolated by app, environment, business tenant and
user; remount on identity changes. Create the web component detached, set
`config.session` before appending it, and remove the old element on logout
or identity switch. Load browser-only SDK modules in the client lifecycle.
The optional `building-glirastes-chat-ui` skill contains a fuller helper.
Cancellation reaches model/API calls but does not undo completed mutations.
Approval replay prevention is not a distributed exactly-once write guarantee;
use backend idempotency when the business operation needs it.

Before claiming acceptance, verify anonymous rejection, same-user reads,
backend denial, write approval/rejection, replay after restart, user/tenant
switching, stream cancellation, one frontend action and export drift. The SDK
repository's `examples/php-runtime` and `examples/frontend-frameworks` are
optional examples, not files required by this packaged reference. Record local
build, image publication, deployment and real-provider acceptance separately.
