# Speech input with a local Parakeet model

Speech-to-text for a finished recording, without a cloud provider: the browser
keeps the audio while the user speaks and sends it once when they stop.

```
browser (RecordedSttAdapter) -> app route -> transcription service
        audio/wav, 16 kHz mono        POST /v1/audio/transcriptions
```

## 1. The service

`server.py` runs Parakeet TDT v3 on Apple Silicon and speaks the common
transcription API. It is for local development and listens on 127.0.0.1.

```sh
uv run examples/stt-parakeet-mlx/server.py   # first start downloads about 670 MB
curl -F file=@recording.wav http://127.0.0.1:8765/v1/audio/transcriptions
```

Any other server with `POST /v1/audio/transcriptions` works the same way, so
production can run the model wherever it fits (a GPU host, a container).

## 2. The app route

The app owns one route that checks the user, limits size and format, and
forwards the recording. Address, key and model of the service stay on the
server. It receives `audio/wav` with `?language=de` and answers
`{ "text": "…" }`.

## 3. The chat

```tsx
import { RecordedSttAdapter, useDeepgramTranscription } from 'glirastes/react';

// One instance for the life of the component.
const adapter = useMemo(() => new RecordedSttAdapter({ url: '/api/ai/speech-recognize' }), []);
const speech = useDeepgramTranscription({ language: 'de', adapter });
```

`VoiceInputAddon` takes the same `adapter`. Without one, both use the live
Deepgram stream.

## What differs from the live stream

- No text appears while speaking; the transcript arrives when the recording ends.
- A recording is capped (`maxSeconds`, default 120).
- Parakeet v3 detects the language itself and has no custom vocabulary.
