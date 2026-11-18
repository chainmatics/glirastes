# Glirastes Runtime container V1

This image hosts the existing Glirastes SDK next to an HTTP backend. It is one
independently deployed service per application and environment, **not one sidecar
per backend replica**. V1 supports one active runtime process; it does not claim
high availability or automatic continuation of a disconnected stream.

The image runs Node 22 as UID/GID 1000 (`node`). Base images are digest-pinned and
Bun installs the committed lockfile. Build and runtime use the same SDK version.
The image includes production dependencies, the exact locked OpenAI-compatible
provider and TypeScript (a production dependency used by artifact generation).
Framework/test peers such as Next.js, React and Vitest are omitted. The provider
imports are checked during the image build against the production dependency
closure. Customers need no Node server code or customer-maintained Node package.

## Use the public release

The Linux amd64 image is public; pulling it needs no GitHub account or registry
credentials. Release 0.17.1 was published from SDK commit `113bb9b`:

```sh
export GLIRASTES_RUNTIME_IMAGE=ghcr.io/chainmatics/glirastes-runtime:0.17.1
docker pull "$GLIRASTES_RUNTIME_IMAGE"
docker run --rm "$GLIRASTES_RUNTIME_IMAGE" --help
```

For production, pin the verified release digest instead of a mutable tag:

```sh
export GLIRASTES_RUNTIME_IMAGE=ghcr.io/chainmatics/glirastes-runtime@sha256:657cda12a33cafcc4fa5ab47cc6e61a971e2d321b74a0b8b1f359ac2a7613543
```

Use SDK 0.17.1 to build artifacts for this image and for the browser package.
The [PHP walkthrough](../../examples/php-runtime/README.md) includes
[Docker Compose](../../examples/php-runtime/compose.yaml) and a sample JSON config.
Its fixture login/reset endpoints are test-only; production uses your existing
backend authentication. See the [0.14.0 release evidence](../../docs/acceptance/2026-11-15-runtime-container-v1.md).

## Build and inspect locally (optional)

From the SDK repository root:

```sh
docker build -f containers/runtime/Dockerfile -t glirastes-runtime:v1-test .
docker run --rm glirastes-runtime:v1-test --help
docker image inspect glirastes-runtime:v1-test --format '{{.Config.User}}'
# Use the local image for the artifact commands below instead of the release:
export GLIRASTES_RUNTIME_IMAGE=glirastes-runtime:v1-test
```

Local builds do not publish. Release tags run the PHP/browser acceptance gate
and publish the exact tested image to `ghcr.io/chainmatics/glirastes-runtime:<version>`
before the npm release completes. Normal PR and main CI builds do not publish.
Pin the released image by digest in production.

## Build customer artifacts

The customer project supplies `.glirastes/tools.json`,
`.glirastes/prompt-bundle.json` and its committed OpenAPI 3.0 or 3.1 JSON export. Optional
policy, descriptions and browser-action declarations use the existing SDK inputs.
There is no separate hand-written tool inventory. Backend export generation and
its freshness check remain part of the customer's build.

For an already configured project, mount it writable for the generator:

```sh
mkdir -p artifacts
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/project" \
  "$GLIRASTES_RUNTIME_IMAGE" \
  build --project /project --out /project/artifacts/release-1
```

`build` runs the existing tool refresh and produces `manifest.json`, `runtime.json`
and `coverage.json`. The runtime payload is data-only JSON; no customer JavaScript
is imported when serving. Use a new output directory for every build. The ordinary
build refreshes the developer-owned working copy's generated files; commit and
review those changes. A CI build instead checks that the committed generation is
current:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/project" \
  "$GLIRASTES_RUNTIME_IMAGE" \
  build --project /project --out /project/artifacts/ci-build --frozen
```

To verify the artifact independently:

```sh
docker run --rm --read-only --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/artifacts/release-1,dst=/artifact,readonly" \
  "$GLIRASTES_RUNTIME_IMAGE" validate --artifact /artifact
```

An exact SDK version match, hashes, schema/binding integrity and application
identity are required. Hashes detect corruption; they do not authenticate an
untrusted publisher. Mount artifacts from your reviewed build read-only.

The container accepts only the subset the existing HTTP caller can execute:
OpenAPI 3.0 or 3.1 JSON, simple scalar path parameters, supported scalar/repeated query
parameters on GET/HEAD/DELETE (a nullable parameter, 3.1 `type: [T, 'null']` or
3.0 `nullable: true`, is not supported), and JSON-object bodies on POST/PUT/PATCH. Explicitly
exclude unsupported operations. Unresolved references, custom header/cookie tool
arguments, write-method query parameters, multipart bodies and unsupported schema
validation keywords fail the build. Declare session authentication using OpenAPI
security schemes rather than model-controlled credential parameters.

## Run

Mount a JSON configuration at `/etc/glirastes/runtime.json`, its approved artifact
at the configured absolute path, and the separately configured secret files.
The default command is:

```sh
glirastes-runtime serve --config /etc/glirastes/runtime.json
```

Use the host's existing reverse proxy to route the chat endpoint under the same
public origin as the application. The backend remains the authority for session,
user, business-tenant and object-level permissions. Do not replace user credentials
with a privileged backend service key.

Production deployment requirements:

- Read-only root filesystem, a small writable `/tmp` tmpfs, dropped capabilities
  and `no-new-privileges`; the runtime process never needs Docker socket access.
- Configuration, artifact and secret files and their parent directories must be readable/traversable by UID 1000. The CLI creates a private artifact directory; when building with a different host UID, assign the deployed artifact to the runtime UID (for example `chown -R 1000:1000 <artifact>`), or grant equivalent group access. No credentials in
  image layers or build arguments. Restrict host and secret-file permissions.
- PostgreSQL for persisted approval consumption and the one-active-runtime lock.
  All processes for the same application/environment must use the same store.
- Fixed backend origin/path allowlist; redirects are refused. Enforce network
  egress to the backend, configured model provider, PostgreSQL and, when enabled,
  the Glirastes Platform.
- A reverse proxy with streaming enabled, response buffering disabled and stream
  timeouts long enough for the configured turn timeout.
- `/healthz` for process liveness and `/readyz` for readiness. The image's default
  healthcheck reads `/etc/glirastes/runtime.json` and probes readiness on localhost.
  Override the Docker healthcheck if you use a different config file.
- SIGTERM drains active work for the configured deadline. Set the orchestrator's
  stop grace period above that deadline. Stop the old instance before starting its
  replacement; do not configure an overlapping rolling deployment for V1.

Browser sessions remain in the customer browser and must be keyed by application,
environment, business tenant and verified user. The image does not add a server-side
conversation database. Frontend actions use the existing browser bridge.

## Acceptance

After building the image, run the repository's PHP/PostgreSQL acceptance suite:

```sh
GLIRASTES_RUNTIME_TEST_IMAGE=glirastes-runtime:v1-test \
  node tests/runtime-container-e2e.mjs
```

This exercises a real non-Node backend with a deterministic model test server.
A deterministic server validates transport and execution behavior; it is not an
acceptance test of a live provider's model quality or availability.
