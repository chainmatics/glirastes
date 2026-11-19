# Vue + FastAPI reference app

A Vue 3 app with `<glirastes-chat>`, a FastAPI backend (`api/`) and the Node
chat runtime next to it (`runtime/`). Python never runs Glirastes. The app is
also the second acceptance app of every release:
[docs/acceptance/second-app-vue-fastapi.md](../../docs/acceptance/second-app-vue-fastapi.md).

## Start for an acceptance run

Once, from the SDK root:

```sh
bun install --frozen-lockfile
bun run build
bun install --frozen-lockfile --cwd examples/vue-fastapi/web
python3.12 -m venv "$(mktemp -d)/venv"   # then install api/requirements.txt into it
```

Then:

```sh
PYTHON=<venv>/bin/python bash examples/vue-fastapi/scripts/acceptance-run.sh
```

The script exports `api/openapi.json`, runs `glirastes tools refresh` and starts
FastAPI on `127.0.0.1:8000`, the chat runtime on `:8787` and Vite on `:5173`.
Open `http://127.0.0.1:5173` and set the fixture session cookie once, as the
script prints. Ctrl-C stops all three.

The UI speaks English, German and Polish: `?lang=de` or `?lang=pl`. The page
names its language in every chat request by itself (`Content-Language`, no
app code); tool labels
come per language from `languages` in `.glirastes/tools.json` and the
endpoints' `x-glirastes-title`, Polish texts of the chat and the runtime are
deliberately partial (`web/src/chat-config.ts`, `runtime/chat.mjs`).

Environment variables (names only; put the key in your shell, never in a file
of this repo):

| Variable | Meaning |
| --- | --- |
| `ACCEPTANCE_MODEL` | OpenRouter model id, e.g. `openai/gpt-4o` or a Claude model. Unset: the chat answers with an error (`runtime/model.mjs` throws). |
| `OPENROUTER_API_KEY` | OpenRouter key, used through the OpenAI-compatible API. |
| `ACCEPTANCE_LIMITS` | `acceptance` (the script's default), `sdk-default` (case 14) or `fixture` (the small CI limits, the default of `runtime/main.mjs`). |
| `ACCEPTANCE_LOCALE` | Locale of the texts the handler writes, e.g. `de-DE`. |
| `PYTHON` | Python with `api/requirements.txt`; default `python3`. |

## Reset the data

The playlists, channels and users are seeded per user on the first request and
kept in memory only: restart the script (or the API) and every delete and
rollback is gone.

## After changing the API

```sh
cd examples/vue-fastapi/api && python3 export_openapi.py
bun ../../../dist/cli/bin.js tools refresh --root ..
```

`api/openapi.json` is committed; the outputs `tools refresh` writes under
`.glirastes/` are not (they are gitignored, and the tests regenerate them).
