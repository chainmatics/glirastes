# Local speech recognition (experimental)

`glirastes/server/stt-local` transcribes a finished browser recording inside
your own Node server. It runs NVIDIA Parakeet TDT 0.6b v3 (int8, CPU) through
the native addon `sherpa-onnx-node`. Audio and transcripts never leave the
process: the subpath makes no network call, and nothing is downloaded at
runtime.

It plugs into the same recording route as a transcription service. The
browser side (`RecordedSttAdapter` posting `audio/wav` to
`/api/ai/speech-recognize`) does not change.

Status: **experimental** (see [support matrix](support-matrix.md#experimental)).
ESM only; there is no CommonJS build of this subpath.

## Install

```bash
npm install glirastes sherpa-onnx-node@2.0.1
npx glirastes stt pull
```

`sherpa-onnx-node` is an optional peer, pinned **exactly** to `2.0.1`:
`sherpa-onnx-linux-x64@2.0.2` needs `CXXABI_1.3.15` (the C++ runtime of GCC 13)
and fails to load on `node:22-bookworm-slim`; 2.0.1 needs only `CXXABI_1.3.9` /
`GLIBCXX_3.4.29`. Another installed version loads with one warning:

```text
sherpa-onnx-node <v> is not tested with glirastes (tested: 2.0.1; linux-x64 2.0.2 does not load on Debian bookworm).
```

## Models: `glirastes stt pull`

```bash
glirastes stt pull [--dir <path>] [--mirror <url>] [--json]
```

It downloads five sha256-pinned files (670 MB in total) and writes the
attribution next to them:

| File | Bytes | Source |
|---|---:|---|
| `parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx` | 652282294 | HuggingFace `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` at commit `ed5d745623472f97cfc2e6c2916ee248798fc5a8` |
| `parakeet-tdt-0.6b-v3-int8/decoder.int8.onnx` | 11845274 | same |
| `parakeet-tdt-0.6b-v3-int8/joiner.int8.onnx` | 6355277 | same |
| `parakeet-tdt-0.6b-v3-int8/tokens.txt` | 93939 | same |
| `silero-vad/silero_vad.onnx` | 643854 | GitHub release `k2-fsa/sherpa-onnx` `asr-models` |
| `ATTRIBUTION.txt` | | written by `stt pull` |

- Each file is written as `<file>.partial-<random>`, hashed while it streams,
  and renamed only when its byte count and sha256 match the pin. A mismatch, an
  overrun, an HTTP error or a network error deletes the partial file and exits
  1 (`E-STT-001` checksum or size, `E-STT-002` HTTP, `E-STT-003` a `--mirror`
  that is not `http:`/`https:`). A file that does not verify is never left
  under its final name.
- A file that is already present with the right size and sha256 is reported
  `verified` and not downloaded again.
- `--mirror <url>` fetches `<url>/<relative path>` for every file: the same
  layout as the model directory, the same sha256 pins.
- `stt pull` only sends GET requests for the pinned files. It sends no
  consumer data and no Platform key.

### Model directory

`--dir`, else `GLIRASTES_MODEL_DIR`, else `$XDG_CACHE_HOME/glirastes/models`,
else `~/.cache/glirastes/models`. `createLocalTranscriber()` uses the same
lookup (`resolveSttModelDir()`). The models are never shipped in the npm
package.

### Attribution

`stt pull` prints this text and writes it to `<modelDir>/ATTRIBUTION.txt`.
Keep it with the models wherever you redistribute them (for example in an image):

```text
Parakeet TDT 0.6B v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) by NVIDIA,
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
Converted to ONNX int8 by sherpa-onnx (Apache-2.0); NVIDIA does not endorse this package.
Silero VAD (https://github.com/snakers4/silero-vad), Copyright (c) 2020-present Silero Team, MIT License.
```

## Route

```ts
// src/app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { createLocalTranscriber } from 'glirastes/server/stt-local';
import { resolvePrincipal } from '@/lib/glirastes-principal';

export const runtime = 'nodejs';

const stt = createLocalTranscriber();

export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => Boolean(await resolvePrincipal(request)),
  transcribe: stt.transcribe,
});
```

`createRecordingTranscriptionHandler` takes either `url` (a transcription
service) or `transcribe` (a `RecordingTranscriber`), never both. In
`transcribe` mode:

- the checks stay the same and in the same order: 401 without a session,
  415 for a content type other than `audio/wav`, 400 for an unknown language or
  an empty body, 413 above `maxBytes` (default 5 MB);
- the handler decodes the WAV itself. It walks the RIFF chunks (`LIST`, `FLLR`
  and other chunks are skipped) and accepts only PCM16, mono, 16 kHz; anything
  else answers **415**. A lying `data` size is read up to the end of the body;
- `timeoutMs` defaults to **120 000** (the `url` mode keeps 45 000). The
  transcriber's `signal` aborts on that timeout and when the client disconnects;
- a `TranscriptionUnavailableError` (the queue is full) answers **503**
  `Speech service busy`; any other failure answers 502 and goes to `onError`.

Any function with the `RecordingTranscriber` shape works there:
`(audio: RecordingAudio, { language, signal }) => Promise<{ text }>`, with
`audio.samples` a `Float32Array` in [-1, 1) at 16 kHz.

### Warm up at server start

The model loads lazily on the first request (1–1.5 s with a warm file cache,
about 9 s cold). Load it at startup instead:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { createLocalTranscriber } = await import('glirastes/server/stt-local');
  await createLocalTranscriber().warmup();
}
```

`createLocalTranscriber()` returns one instance per model directory, thread
count and mode in a process (a registry on `globalThis`), so the route and
`instrumentation.ts` share the loaded model, and a module that Next.js dev HMR
re-evaluates does not start a second 1.2 GB worker. Other options of a later
call with the same three values are ignored.

## Next.js

<!-- nextjs-verification -->
List **both** the native addon and glirastes as server externals, so the
bundler leaves the addon, the dynamic import and the worker file in
`node_modules`:

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: ['sherpa-onnx-node', 'glirastes'],
};
export default nextConfig;
```

The route must run on the Node.js runtime (`export const runtime = 'nodejs'`).

Verified on 2026-11-21 with Next.js 15.5.29 (webpack, `next build && next start`),
the packed SDK and `sherpa-onnx-node` 2.0.1 on darwin-arm64, by posting
`tests/fixtures/stt/de-thorsten.wav` to the route above:

| `serverExternalPackages` | `mode` | Result |
|---|---|---|
| `['sherpa-onnx-node', 'glirastes']` | `worker` | works: 200 with the German text (1.9 s first request including the model load, 0.2 s after that) |
| `['sherpa-onnx-node', 'glirastes']` | `inline` | works: 200 with the German text |
| `['sherpa-onnx-node']` | `worker` | fails: 502, `peer_missing` |
| none | `worker` | fails: 502, `peer_missing` |
| none | `inline` | fails: 502, `peer_missing` |

The build succeeds in every case. Without `glirastes` in the list, webpack
bundles `glirastes/server/stt-local` and replaces its dynamic import of the
addon with a stub that throws `Cannot find module 'sherpa-onnx-node'`,
although the package is installed. `mode: 'inline'` does not avoid that,
so it is no substitute for the externals; keep it for hosts where worker
threads are unavailable. The `peer_missing` message then carries a second
sentence that names `serverExternalPackages`.

## Options

```ts
createLocalTranscriber({
  modelDir,          // default resolveSttModelDir()
  numThreads: 2,     // integer 1–16; 4 threads were about 30 % faster on Apple M3 Pro
  mode: 'worker',    // or 'inline'
  maxQueue: 4,       // jobs waiting behind the running one; more answer 503
  hardStopGraceMs: 5000,
  onWarning,         // default console.warn
});
```

- **`mode: 'worker'`** (default): one worker thread per process loads the model
  and decodes one job at a time. The main thread loads the addon before the
  first worker starts (about 40 ms, 10 MB, no model), because a restarted
  worker cannot load it on linux-arm64 otherwise (`Module did not self-register`).
- **Cancellation**: a client disconnect or the timeout sets a cancel flag that
  the worker reads between chunks; the warm worker keeps running. Only a job
  that has not answered `hardStopGraceMs` after its cancellation is stopped
  with `worker.terminate()`; the next job then starts a fresh worker and
  reloads the model (1–9 s). A worker that dies (native crash, out of memory)
  fails its running job with `SttLocalError` `worker_failed`; queued jobs run on
  a new worker.
- **`mode: 'inline'`**: no worker. The model loads with
  `OfflineRecognizer.createAsync` and decodes with `decodeAsync` on the libuv
  threadpool, which does not block the event loop but occupies threadpool
  threads. Same chunking, the same bounded queue and the same between-chunk
  cancellation; there is no hard stop.
- `warmup()` runs the platform check, loads the peer, checks the model files
  (presence and size) and loads the model. `close()` terminates the worker and
  removes the instance from the registry.

## How audio is processed

- Very quiet input (`0 < peak < 0.1`) is amplified by `min(0.5 / peak, 20)`.
- Audio of at most 20 s is decoded whole.
- Longer audio goes through the Silero VAD, which only locates silences. The
  **original** audio is cut at the midpoints between speech spans into chunks
  of at most 20 s (at least 2 s each). When no silence fits, the cut falls on
  the quietest 30 ms frame in the last 8 s of the window. 0.3 s of padding
  stays before the first and after the last span. Chunk texts are joined with
  single spaces. No speech at all returns an empty text.
- Parakeet detects the language itself; the handler still validates
  `?language=`, but the local transcriber ignores it.
- No streaming: the browser sends the finished recording (at most 120 s), which
  takes about 5 s on arm64.

## Platforms

| Platform | Status |
|---|---|
| macOS arm64 | supported |
| Linux x64, glibc ≥ 2.32 and the C++ runtime of GCC ≥ 11 (Debian 12, Ubuntu 22.04+) | supported with `sherpa-onnx-node` 2.0.1 |
| Linux arm64, glibc ≥ 2.17 | supported |
| musl / Alpine | refused |
| Linux x64 with glibc < 2.32 (Debian 11, Ubuntu 20.04, RHEL 8, Amazon Linux 2) | refused |
| Windows, macOS x64 | not tested: one warning `<platform>-<arch> is not tested with glirastes/server/stt-local.`, then it continues |

## Memory and timing

- About **1.2 GB** steady and up to about **1.6 GB** per process while decoding
  20 s chunks. Plan a **2 GB** container memory limit.
- Model load 1–1.5 s with a warm file cache, about 9 s cold.
- Real-time factor about 0.04 on arm64 with 2 threads (a 7 s clip in about
  0.3 s).

## Container recipe

Pull the models at image build, into a directory the image keeps:

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
ENV GLIRASTES_MODEL_DIR=/models
COPY package.json package-lock.json ./
RUN npm ci
RUN npx glirastes stt pull --dir /models
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

Run it with at least 2 GB of memory (`docker run --memory=2g`). Not on Alpine.

## Readiness check without a model

```ts
import { checkLocalStt } from 'glirastes/server/stt-local';

const result = await checkLocalStt();
// { platform: 'linux', arch: 'arm64', glibc: '2.36', sherpaVersion: '2.0.1', workerRestarts: 1 }
```

`checkLocalStt()` runs the platform check, loads the addon on the main thread,
starts a worker that loads the addon, restarts that worker and probes again. It
loads no model, so it fits a deploy check or CI step.

## Errors

`SttLocalError` has a `code` (`SttLocalErrorCode`). Its messages never carry
audio or transcript content.

| Code | When | Message |
|---|---|---|
| `peer_missing` | `sherpa-onnx-node` is not installed | `glirastes/server/stt-local needs the optional peer sherpa-onnx-node 2.0.1. Install it: npm install sherpa-onnx-node@2.0.1` |
| `peer_missing` | a bundler inlined glirastes (Next.js without `serverExternalPackages`) | the same, followed by `. If it is installed, a bundler has inlined the import: in Next.js set serverExternalPackages: ['sherpa-onnx-node', 'glirastes']` |
| `load_failed` | the native addon or the model does not load (`ERR_DLOPEN_FAILED`, `GLIBC_`, `GLIBCXX_`, `CXXABI_`, a missing `sherpa-onnx-<platform>-<arch>` package, …) | `sherpa-onnx-node <installed version \| unknown> failed to load: <original message>. glirastes is tested with sherpa-onnx-node 2.0.1: npm install sherpa-onnx-node@2.0.1` |
| `platform_unsupported` | musl / Alpine | `glirastes/server/stt-local needs glibc; musl-based Linux (Alpine) is not supported. Use a Debian or Ubuntu based image such as node:22-bookworm-slim.` |
| `platform_unsupported` | Linux x64 below glibc 2.32 | `glirastes/server/stt-local needs glibc 2.32 or newer on linux-x64 (found <v>).` |
| `models_missing` | a model file is missing or has the wrong size | names every such path and ends with `Run: glirastes stt pull` |
| `worker_failed` | the worker exited while a job ran | `The local speech worker exited unexpectedly (code <n>)…` |

In the route these become 502 (`onError` receives the error); a full queue is
a 503.

## Raising the sherpa-onnx-node pin

CI tests the pinned version in two stages: a model-free addon check
(`checkLocalStt()`, every pull request and every release) and a transcription
with the real model (on changes to this feature, weekly and on demand), both on
`node:22-bookworm-slim` amd64 and arm64 and on macOS arm64. A weekly job runs
the same against `sherpa-onnx-node@latest` and may fail.

1. Wait for a green weekly `latest` job.
2. Raise the exact pin in `package.json#peerDependencies['sherpa-onnx-node']`
   (and `TESTED_SHERPA_VERSION` in `src/server/stt-local/sherpa.ts`); CI reads
   the version from `package.json`.
3. Both stages must be green on that pull request.

## Content boundary

Audio and transcripts stay in your process. `glirastes/server/stt-local` makes
no network call and never downloads anything; `glirastes stt pull` downloads
only the pinned model files. Nothing of this path reaches the Glirastes
Platform.
