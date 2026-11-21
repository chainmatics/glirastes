# Local speech recognition

Experimental. The `recording` speech input (`RecordedSttAdapter`, `audio/wav`
to `/api/ai/speech-recognize`) can be transcribed inside the app's own Node
server instead of a transcription service. The browser side does not change.
Full guide with platforms, memory and the container recipe: `docs/local-stt.md`
in the package.

## Contents

- Setup
- Route
- What the route answers
- Readiness and errors

## Setup

1. `npm install sherpa-onnx-node@2.0.1`, exactly: linux-x64 2.0.2 does not load
   on Debian bookworm. glibc Linux (Debian/Ubuntu, never Alpine) or macOS arm64.
2. `glirastes stt pull` downloads the sha256-pinned models (670 MB) into
   `GLIRASTES_MODEL_DIR`, else `~/.cache/glirastes/models`
   (`resolveSttModelDir()` gives the path). In a container, run it at image
   build. Nothing is downloaded at runtime.
3. Plan 2 GB of memory per process (about 1.2 GB steady).

## Route

```ts
// src/app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { createLocalTranscriber } from 'glirastes/server/stt-local';
import { resolvePrincipal } from '@/lib/glirastes-principal';

export const runtime = 'nodejs';
const stt = createLocalTranscriber(); // LocalTranscriberOptions: modelDir, numThreads, mode, maxQueue, …
export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => Boolean(await resolvePrincipal(request)),
  transcribe: stt.transcribe,
});
```

- The config with `transcribe` is a `LocalRecordingTranscriptionHandlerConfig`;
  it never takes `url`, `apiKey`, `model` or `fetch`.
- `transcribe` is any `RecordingTranscriber`:
  `(audio: RecordingAudio, { language, signal }) => Promise<{ text }>`, where
  `audio.samples` is a `Float32Array` at 16 kHz. Throw
  `TranscriptionUnavailableError` from your own transcriber to answer 503.
- The `LocalTranscriber` from `createLocalTranscriber()` also has `warmup()`
  (call it from `instrumentation.ts`) and `close()`. One instance per model
  directory, threads and mode in a process, so dev HMR reuses the loaded model.
- `next.config.ts`: `serverExternalPackages: ['sherpa-onnx-node', 'glirastes']`,
  both of them (verified with Next.js 15.5); `mode: 'inline'` is no substitute.

## What the route answers

| Status | When |
|---|---|
| 200 `{ text }` | transcribed (empty text when no speech was found) |
| 401 | `authorize` returned false |
| 400 | unknown `?language=` or empty body |
| 413 | above `maxBytes` (5 MB) |
| 415 | not `audio/wav`, or a WAV that is not PCM16 mono 16 kHz |
| 502 | the transcriber failed (`onError` gets the error) or the 120 s timeout hit |
| 503 | the queue is full (`maxQueue`, default 4 waiting jobs) |

Parakeet detects the language itself; `?language=` is still validated.

## Readiness and errors

`checkLocalStt()` loads only the addon, restarts its worker once and resolves a
`LocalSttCheck` (`platform`, `arch`, `glibc`, `sherpaVersion`,
`workerRestarts: 1`); no model is needed, so it fits a deploy check.

Failures are `SttLocalError` with a `code` of type `SttLocalErrorCode`:
`peer_missing` (install the peer), `load_failed` (the addon or model did not
load; the message names the installed version), `platform_unsupported` (musl,
or linux-x64 below glibc 2.32), `models_missing` (run `glirastes stt pull`),
`worker_failed` (the worker died; the next job gets a fresh one).
