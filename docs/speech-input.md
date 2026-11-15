# Speech input with OpenRouter

Use `RecordedSttAdapter` with the chat's existing STT controller. It collects one
16 kHz mono WAV in memory, sends it once on Stop, and appends the final transcript
to the editable draft. It has **no interim transcripts**. Streaming adapters may
supply interim segments; the same controller merges them. Neither adapter sends
chat messages automatically.

## Install the browser asset

The AudioWorklet runs in a separate browser thread. It must be served as a public
JavaScript file; importing the adapter does not install that file on your web
server. The stable package export is `glirastes/stt/audio-worklet-processor.js`.
Do not depend on private `dist/` paths.

Create `scripts/copy-speech-asset.mjs`:

```js
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await mkdir('public', { recursive: true });
await copyFile(
  require.resolve('glirastes/stt/audio-worklet-processor.js'),
  'public/audio-worklet-processor.js',
);
```

Run this before development and production builds (merge with existing scripts):

```json
{
  "scripts": {
    "predev": "node scripts/copy-speech-asset.mjs",
    "dev": "next dev",
    "prebuild": "node scripts/copy-speech-asset.mjs",
    "build": "next build"
  }
}
```

## Server endpoint

```ts
// app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { resolvePrincipal } from '@/lib/auth'; // your server-verified identity

export const runtime = 'nodejs';
export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => {
    // Compare against your configured PUBLIC origin, not an internal proxy URL.
    if (request.headers.get('origin') !== process.env.APP_ORIGIN) return false;
    return Boolean(await resolvePrincipal(request));
  },
  url: 'https://openrouter.ai/api',
  apiKey: process.env.OPENROUTER_API_KEY,
  model: 'openai/whisper-1',
});
```

`resolvePrincipal` must validate your app's session and membership. Keep the
provider key server-side; use the existing OpenRouter key, not a second provider.
The handler adds `/v1/audio/transcriptions`, so its `url` ends in `/api`, **not**
`/api/v1`. OpenRouter supports this multipart protocol; see the official
[speech-to-text documentation](https://openrouter.ai/docs/guides/overview/multimodal/stt).
Model availability remains provider-controlled.

## Composer and base paths

```tsx
import { useMemo } from 'react';
import { RecordedSttAdapter } from 'glirastes/stt';

// In your existing client component; use the same prefix as next.config basePath.
const basePath = '/fieldwork'; // '' when served at the origin root
const adapter = useMemo(() => new RecordedSttAdapter({
  url: `${basePath}/api/ai/speech-recognize`,
  workletUrl: `${basePath}/audio-worklet-processor.js`,
}), [basePath]);
const voice = useMemo(() => ({ enabled: true, adapter, routeKey: pathname }), [adapter, pathname]);
// Pass voice={voice} to the existing AiChatProvider; do not add a recorder.
```

The default worklet URL remains `/audio-worklet-processor.js` for compatibility.
`workletUrl` also accepts an absolute hosting URL and is available on
`DeepgramSttAdapter`. A CDN must provide appropriate cross-origin headers and be
allowed by your CSP. A Next.js `assetPrefix` does not automatically relocate
`public/` assets: pass the actual served URL. Microphones and AudioWorklets require
a secure browser context (HTTPS or localhost).

## Verification and troubleshooting

- Fetch the configured worklet URL in the deployed app: expect 200, JavaScript
  MIME type and processor code, not an HTML fallback page.
- A failed asset load closes the AudioContext and reports the URL plus a repair
  hint through `voice.onError`. The composer shows a localized asset error and
  retry control. Check network errors, CSP and the base path before retrying.
- Denied permission and provider failures show a localized recording error;
  retry is an explicit user action. Provider response bodies are not exposed.
- Stop inserts an editable draft once. Cancel discards the recording. Navigation,
  chat hiding, session changes and unmount release microphone resources. Test
  these paths with a synthetic microphone and your real app router.
- The default recording cap is 120 seconds; `maxSeconds` changes it. Later audio
  is dropped. The server independently limits body size (5 MB) and timeout
  (45 seconds). No audio is stored by the SDK after completion/cancellation.

Migration from 0.14.0: replace private `dist/react/audio-worklet-processor.js`
copy paths with the public export. Existing root-hosted assets keep working.
Accessible controls now use localized labels and SVG icons, so browser tests
should select `Start recording` / `Aufnahme starten` rather than the old `mic`
placeholder. Remove CSS pseudo-elements or masks that replaced those old literal
placeholders, otherwise they appear alongside the new SVG icons. Optional locale keys `recordingErrorLabel` and
`recordingAssetErrorLabel` customize the visible errors.
