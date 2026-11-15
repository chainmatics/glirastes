# PHP backend with the Glirastes Runtime V1

This reference runs the same SDK chat handler as a Node/Next application, in a
separate configurable service. PHP owns session validation, workspace selection,
role checks and task mutations. No customer-written Node server is needed.

**Local fixture only:** `alice`, `bob`, `reader-a`, and `reader-b` are known
sessions; `/fixture/login`, `/fixture/reset`, `/fixture/state`, and
`/fixture/revoke` are deliberately unauthenticated test controls. Never expose
this fixture outside a development machine. Replace it with your own API.

## Automated acceptance

From the SDK repository root, with Bun, Node, Docker and an installed Playwright:

```sh
bun install --frozen-lockfile
bun run build
docker build -f containers/runtime/Dockerfile -t glirastes-runtime:v1-test .
GLIRASTES_RUNTIME_TEST_IMAGE=glirastes-runtime:v1-test \
  PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node --test tests/runtime-container-e2e.mjs
```

Set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome. Otherwise install
Playwright's Chromium first. CI supplies Playwright and runs the browser gate.
Without `PLAYWRIGHT_MODULE`, the runner reports the browser test as skipped;
that is not a passed browser acceptance. Without `GLIRASTES_RUNTIME_TEST_IMAGE`,
the runner executes the built Node host while PHP and PostgreSQL still run in
Docker. The complete image acceptance requires the image variable above.

The runner creates an isolated Docker network, PHP and PostgreSQL containers,
a deterministic OpenAI-compatible model endpoint and a local streaming ingress.
It uses disposable test credentials, no paid model service and no platform
account. It removes containers and temporary project files on completion.

It verifies:

- Anonymous and cross-origin chat requests are refused.
- Two workspaces with the **same user ID** remain distinct.
- Only the allowlisted session cookie reaches the backend.
- Read tools return only the current workspace's data.
- Rejected, modified, cross-workspace and revoked-session approvals cannot write.
- A reader remains unable to write even after approving a tool call.
- A permitted write waits for approval; replay after a runtime restart does not
  execute it again.
- A backend call with mismatched pinned identity is rejected.
- Cancelling the browser HTTP stream cancels the model-provider request.
- The real browser streams a read, invokes a registered frontend action,
  confirms a write and restores its local conversation after reload.
- The checked-in OpenAPI export matches the PHP source contract.

The deterministic provider proves the integration and protocol, not answer
quality from an actual model. Platform synchronization and provider-specific
behavior need their separate acceptance tests.

## Local Compose demo

Build the SDK and runtime image as above, then prepare the read-only artifact
and browser assets from the repository root:

```sh
mkdir -p examples/php-runtime/.prepared/project
cp -R examples/php-runtime/api examples/php-runtime/web \
  examples/php-runtime/.glirastes examples/php-runtime/.prepared/project/
node dist/runtime-service/bin.js build \
  --project examples/php-runtime/.prepared/project \
  --out examples/php-runtime/.prepared/artifact
bun build examples/php-runtime/web/main.ts --target browser --format esm \
  --production --outdir examples/php-runtime/.prepared/web
cp examples/php-runtime/web/index.html examples/php-runtime/.prepared/web/index.html
cp examples/php-runtime/runtime.example.json examples/php-runtime/runtime.json
```

The artifact output must be a new directory. For another version, choose a new
output directory and update the mounted path rather than overwriting a live
artifact. Edit `runtime.json` with the actual model ID and, if necessary, the
OpenAI-compatible provider base URL. It defaults to OpenRouter.

Create `examples/php-runtime/.secrets/` locally and these files without adding
them to Git:

| File | Value |
| --- | --- |
| `model_key` | Model provider API key |
| `approval_key` | At least 32 random characters; preserve across restarts |
| `db_password` | Password for the local demo PostgreSQL user |
| `state_dsn` | `postgres://postgres:ENCODED_PASSWORD@state:5432/glirastes` |

Compose mounts these as secret files. Ensure the non-root runtime user can read
the mounted files. Start the local demo:

```sh
docker compose -f examples/php-runtime/compose.yaml up -d --build
curl -c /tmp/glirastes-demo.cookies -H 'Content-Type: application/json' \
  -d '{"user":"alice"}' http://localhost:8088/fixture/login
```

For browser login, open `http://localhost:8088`, run the following in that
page's developer console, then reload:

```js
await fetch('/fixture/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user: 'alice' }),
});
location.reload();
```

The demo requires the `localhost` hostname because it is the configured public
origin. The ingress binds only to the local machine. `docker compose ... down`
stops it; the named PostgreSQL volume preserves consumed approvals. Do not
delete that volume while unexpired signed approvals can still be submitted.

## Contract to implement in a customer's backend

`GET /api/me` validates the caller's session and returns exactly:

```json
{"userId":"user-123","tenantId":"workspace-456","roles":["writer"]}
```

The runtime adds `x-glirastes-user-id` and `x-glirastes-business-tenant` to tool
requests, pinned to the verified identity. Compare these with the **current**
session in the backend; reject a mismatch. These headers cannot authorize
anything. The session still decides all permissions and data access. Ordinary
application calls may omit them. This check prevents a mutable session from
switching workspace between identity verification and tool execution.

The fixture exports OpenAPI 3.1 JSON from `api/contract.php`:

```sh
docker run --rm -v "$PWD/examples/php-runtime/api:/app:ro" \
  php:8.4-cli-alpine php /app/export-openapi.php \
  > examples/php-runtime/api/openapi.json
```

The PHP handlers enforce those input shapes and authenticate each operation.
CI checks export freshness. Customer projects should export from their
framework's authoritative route/schema definitions and verify the same link.
The runtime artifact builder reports unsupported operations instead of silently
publishing a weaker tool.

The browser configures `createLocalSessionStore` before attaching the chat
element. Its storage key includes application, environment, verified workspace
and user. In a real app, unmount/recreate the chat when that identity changes.

Rust and Java backends can implement the same HTTP contract. This fixture is
evidence for PHP; it is not a claim that every Rust or Java stack has been tested.
