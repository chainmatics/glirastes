# Choose and prepare the customer runtime

This reference is self-contained so setup-only installations remain useful even
when framework/UI skills were not selected. Full configuration guidance is also
available in `integrating-glirastes-web` when that optional skill is installed.

## Host decision

1. Reuse an existing Node/Next.js server if it authenticates the user, can reach
   the API and supports long streams. The framework-neutral handler is
   `createAiChatHandler` from `glirastes/server/http`; the Next.js export remains
   compatible; for `node:http`-style servers wrap it with `createNodeHandler`
   (`glirastes/server/node`). Keep existing SDK tools, guards and authorization.
2. For Rust/PHP/Java or an application without a suitable Node host, use the
   0.14 `glirastes-runtime` container. It is one active service per app/environment,
   independently of backend replica count. The customer needs no Node server code
   or package.json for an OpenAPI-only build.
3. A real sidecar is an exception for local-only interfaces or coupled lifecycle.
   V1 offers neither HA nor multiple active runtimes in one app/environment.

## Package dependencies in a Node host

The SDK depends on `zod` 4 (`^4.0.0`). An app on zod 4 shares its copy; an app
on zod 3 gets a second zod 4 copy for the SDK. App schemas keep working because
the SDK reads schemas by shape; the cost is disk and bundle size, and the zod 4
contract schemas the SDK exports cannot be nested in zod 3 schemas. Do not
upgrade the app's zod only for the SDK. `pg` (`>=8.11 <9`) is used only by the
`glirastes-runtime` binary; any pg 8.11+ the app has is shared.

## Container input contract

The official public image is
`ghcr.io/chainmatics/glirastes-runtime:0.26.0` for Linux amd64; no registry login
is required. Pin the approved digest in production and match its exact SDK
version in artifact generation and the browser package. The
[image guide](https://github.com/chainmatics/glirastes/blob/v0.26.0/containers/runtime/README.md)
and [PHP Compose example](https://github.com/chainmatics/glirastes/tree/v0.26.0/examples/php-runtime)
are optional source references; the contracts below remain available offline.

Provide `.glirastes/tools.json` with schemaVersion 1, a stable unique UUID appId,
targetAppKey, locale and an OpenAPI source:
`{"kind":"openapi","document":"api/openapi.json"}`. Preserve an existing appId.
The matching `.glirastes/prompt-bundle.json` contains schemaVersion 1, that same
appId, a local artifactRef and sections `planner`, `appBehavior`, `responseStyle`
and `capabilityFragments`. These are normal SDK inputs, not a new tool inventory.

Export OpenAPI 3.0 or 3.1 JSON from the authoritative backend schema. Omit `fastapi` for
non-Python APIs. To expose only chosen operations, add `"selection":"opt-in"` and
mark them `x-glirastes-tool: true` in the export (see `integrating-glirastes-web`). The runtime supports a strict subset: simple path parameters,
supported GET/HEAD/DELETE query parameters and POST/PUT/PATCH JSON-object bodies.
Unsupported active operations fail build; explicitly excluded operations appear
in coverage. Never manually enable generated tools to bypass diagnostics.

Run with the matching installed CLI or as arguments to the approved runtime image:

```sh
glirastes-runtime build --project /workspace/app --out /artifacts/release-1
glirastes-runtime validate --artifact /artifacts/release-1
glirastes-runtime build --project /workspace/app --out /artifacts/ci-1 --frozen
```

Use a new output directory each time. Commit/review generated outputs before the
frozen CI build. CI must separately regenerate and check the OpenAPI export.
Artifacts are data-only JSON, pinned to the exact SDK version; mount approved
artifacts read-only in production. A local image build does not publish or deploy it.

## Minimum service configuration

Strict JSON at `/etc/glirastes/runtime.json`:

```json
{
  "schemaVersion": 1,
  "server": { "publicOrigin": "https://app.example.com" },
  "application": {
    "artifact": "/app/artifact",
    "apiOrigin": "http://backend:8080",
    "allowedPathPrefixes": ["/api"]
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

JSON does not interpolate environment variables. Secret/artifact paths are
absolute. Supply a 32+ character random approval secret and a restricted PostgreSQL
connection through mounted files, not source code. PostgreSQL persists approval
consumption and the one-active-runtime lock; all processes for the same scope
must use the same store. Initialization needs permission to create its tables.

A failed backend call reaches the model with its HTTP `status` and capped
`body`. The SDK's `classifyToolFailure` (expected business failures such as a
403 outside the error budget) is a function and not configurable in this JSON
yet: in the container every failed backend call counts as a tool error. A tool the
identity's roles or the policy do not allow is not offered to the model. A call
to it anyway never executes: the AI SDK answers it as an unavailable tool and
the turn continues, bounded by `maxModelSteps`. A tool that becomes denied
after the request started (a role lost) gets
`Tool execution denied: <reason> (<tool>)` as a tool error instead, counted
toward `maxConsecutiveErrors`. At the turn budget (`limits.maxToolCalls`,
default 8, `read_result` included; capped by agent revision and policy) the
remaining calls get `Tool call not executed: the limit of 8 tool calls per
turn is reached (8 used). ...`, the chat shows `Tool call limit for this turn
reached (8).` and the turn ends with one final answer.
A turn that reaches `limits.maxModelSteps` (default 10, before 0.24 it was 6)
or `limits.maxInputTokens` (default 60,000, before 40,000) ends with a stop
notice that lists what was done and what is open; the chat's "Continue" button
continues it without repeating a write call (see `docs/managed-runtime-sync.md`,
"Continuing a stopped turn"). Set both limits explicitly to keep the old values.

The identity endpoint validates the selected cookie/bearer credential and returns
exactly `{"userId":"42","tenantId":"business-a","roles":["editor"]}`.
The tenant here is the business tenant, not the platform tenant. Tool requests
carry verified `x-glirastes-user-id` and `x-glirastes-business-tenant`; backend
middleware must reject a mismatch with its current session and retain every
existing object/role/tenant check. Those headers and a user's confirmation grant
no permissions. Never use a privileged service account instead of the user.

Route `/glirastes/chat` through the existing app origin. Preserve backend CSRF:
configure `identity.csrfHeader` (`x-csrf-token` or `x-xsrf-token`) and send that
header when needed. Browser roles or tenant claims are not trusted.

Start `glirastes-runtime serve --config /etc/glirastes/runtime.json`. The image
runs nonroot; deploy config/artifacts read-only with readable mounted secrets,
a writable `/tmp` tmpfs, dropped capabilities and constrained network egress.
Disable proxy buffering and automatic POST retries. `/healthz` is liveness;
`/readyz` includes dependencies. SIGTERM drains then aborts; stop the old instance
before starting a replacement. Cancellation cannot undo a completed backend write.

For authorized connected mode use platform `{ "enabled": true, "environment":
"production", "apiKeyFile": "/run/secrets/glirastes_key",
"requireAcceptedDeployment": true }`. Cold startup waits for an accepted
platform deployment; a failed connection never selects standalone automatically.
A retained revision can continue during transient outages, so remote revocation
is not instantaneous while disconnected.

## Frontend and acceptance

React uses the existing chat component. Other frontends can mount
`<glirastes-chat>` with browser-only dynamic imports. Create it detached, install
`config.session` keyed by app/environment/business tenant/user, then append it.
Destroy/remount on identity changes; dispose pending initialization and browser
actions. Browser history is local; V1 has no cross-device conversation service.

Verify anonymous rejection, same-user reads, denied writes, approval/rejection,
replay after restart, tenant/user switches, streaming/cancellation and one UI
action. Keep package/image publication, customer deployment and real-provider
acceptance separate in the result report.
