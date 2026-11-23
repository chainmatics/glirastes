# Recording transcription route

For the `recording` speech input. The browser records, the app's own server
route transcribes, and the transcript returns to the composer for review.

A finished recording (`RecordedSttAdapter`, `audio/wav` to
`/api/ai/speech-recognize`) needs one route; the app's transcription service
(any `POST /v1/audio/transcriptions` server) stays on the server:

```ts
// src/app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { resolvePrincipal } from '@/lib/glirastes-principal';

export const runtime = 'nodejs';
export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => Boolean(await resolvePrincipal(request)),
  url: process.env.STT_RECORDING_URL,
  apiKey: process.env.STT_RECORDING_API_KEY,
  model: process.env.STT_RECORDING_MODEL,
  localOnly: true, // protected profile: private service address only
});
```

The handler reads at most `maxBytes` (5 MiB), refuses anything that is not
a WAV file or runs longer than `maxDurationSeconds` (60), runs
`maxConcurrent` (2) transcriptions and queues `maxQueued` (8) before 429. It
never follows a redirect, cancels the service call when the browser aborts
and logs failure codes only. A missing `text` is a failure, not silence.
`localOnly` refuses a service URL that `isPrivateServiceUrl` rejects;
`wavDurationSeconds` reads the length from the WAV header. There is no
cloud fallback.
