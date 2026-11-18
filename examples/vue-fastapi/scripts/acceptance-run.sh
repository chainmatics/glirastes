#!/usr/bin/env bash
# Starts the Vue+FastAPI reference app for a manual acceptance run
# (docs/acceptance/second-app-vue-fastapi.md): FastAPI on :8000, the Node
# chat runtime on :8787, the Vue dev server on :5173. Ctrl-C stops all three;
# the next start reseeds the fixture data (every delete and rollback is gone).
#
# Prerequisites: `bun run build` in the SDK root, Python 3.12 with
# api/requirements.txt (PYTHON, default python3), `bun install` in web/.
# Model: ACCEPTANCE_MODEL and OPENROUTER_API_KEY (see runtime/model.mjs).
# Optional: ACCEPTANCE_LIMITS (fixture | acceptance | sdk-default, default
# acceptance here), ACCEPTANCE_LOCALE (e.g. de-DE).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="$(cd "$APP/../.." && pwd)"
PYTHON="${PYTHON:-python3}"
TENANT_ID='019fb007-0000-7000-8000-000000000002'
# A fixture session, not a secret: the browser sends it as the `session` cookie.
SESSION_TOKEN="${SESSION_TOKEN:-acceptance-alice}"

[ -f "$SDK/dist/cli/bin.js" ] || { echo "Run bun run build in $SDK first." >&2; exit 1; }
[ -d "$APP/web/node_modules" ] || { echo "Run bun install in $APP/web first." >&2; exit 1; }
"$PYTHON" -I -c 'import fastapi, uvicorn, pydantic' 2>/dev/null \
  || { echo "$PYTHON cannot import fastapi, uvicorn and pydantic; install api/requirements.txt." >&2; exit 1; }
[ -n "${ACCEPTANCE_MODEL:-}" ] || echo "ACCEPTANCE_MODEL is not set: the chat answers with an error until it is." >&2

# The app resolves `glirastes` to this SDK checkout, as a consumer resolves the package.
mkdir -p "$APP/node_modules"
[ -e "$APP/node_modules/glirastes" ] || ln -s "$SDK" "$APP/node_modules/glirastes"

(cd "$APP/api" && "$PYTHON" -B export_openapi.py)
bun "$SDK/dist/cli/bin.js" tools refresh --root "$APP"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

FIXTURE_SESSIONS="{\"$SESSION_TOKEN\":{\"subjectId\":\"alice\",\"tenantId\":\"$TENANT_ID\",\"roles\":[\"member\"]}}" \
  "$PYTHON" -I -B -m uvicorn --app-dir "$APP/api" app.main:app --host 127.0.0.1 --port 8000 &
pids+=($!)
API_ORIGIN=http://127.0.0.1:8000 TENANT_ID="$TENANT_ID" PORT=8787 \
  ACCEPTANCE_LIMITS="${ACCEPTANCE_LIMITS:-acceptance}" bun "$APP/runtime/main.mjs" &
pids+=($!)
(cd "$APP/web" && GLIRASTES_SDK_DIR="$SDK" bun run dev -- --host 127.0.0.1 --port 5173 --strictPort) &
pids+=($!)

echo "Open http://127.0.0.1:5173 and set the cookie once in the console: document.cookie = 'session=$SESSION_TOKEN'"
wait
