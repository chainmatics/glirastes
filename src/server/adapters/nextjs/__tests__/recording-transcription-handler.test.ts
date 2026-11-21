import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../../../../react/stt/recorded.js';
import {
  createRecordingTranscriptionHandler,
  TranscriptionUnavailableError,
  type RecordingTranscriber,
} from '../recording-transcription-handler.js';

const wav = (bytes = 8) => new Uint8Array(bytes).fill(1);

function request(options: { body?: Uint8Array; type?: string; query?: string } = {}) {
  return new Request(`http://app.test/api/ai/speech-recognize${options.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': options.type ?? 'audio/wav' },
    body: (options.body ?? wav()) as BodyInit,
  });
}

function service(answer: () => Promise<Response> | Response = () => Response.json({ text: '  Hallo Welt \n' })) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => answer());
}

const allow = async () => true;

describe('createRecordingTranscriptionHandler', () => {
  it('refuses a request the app does not authorize', async () => {
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: async () => false, url: 'http://stt', fetch });
    const response = await handler(request());
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 503 when no transcription service is configured', async () => {
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: undefined, fetch: service() });
    expect((await handler(request())).status).toBe(503);
  });

  it('accepts only wav audio', async () => {
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service() });
    expect((await handler(request({ type: 'audio/webm' }))).status).toBe(415);
  });

  it('refuses an unknown language and an empty or oversized recording', async () => {
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service(), maxBytes: 16 });
    expect((await handler(request({ query: '?language=xx' }))).status).toBe(400);
    expect((await handler(request({ body: new Uint8Array(0) }))).status).toBe(400);
    expect((await handler(request({ body: wav(17) }))).status).toBe(413);
  });

  it('forwards the recording to the transcription API and returns the trimmed text', async () => {
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({
      authorize: allow,
      url: 'http://stt:8765/',
      apiKey: 'stt-key',
      model: 'whisper-1',
      fetch,
    });
    const response = await handler(request({ query: '?language=en-US' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hallo Welt' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://stt:8765/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer stt-key');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).type).toBe('audio/wav');
  });

  it('defaults to German, the Parakeet model and no key', async () => {
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch });
    await handler(request());
    const [, init] = fetch.mock.calls[0]!;
    expect(init!.headers).toEqual({});
    const form = init!.body as FormData;
    expect(form.get('language')).toBe('de');
    expect(form.get('model')).toBe('parakeet-tdt-0.6b-v3');
  });

  it('answers 502 without the service detail when the service fails', async () => {
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({
      authorize: allow,
      url: 'http://stt',
      fetch: service(() => new Response('secret detail', { status: 500 })),
      onError,
    });
    const response = await handler(request());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret detail');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createRecordingTranscriptionHandler with a local transcriber', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pcm = () => new Uint8Array(encodeWav([Int16Array.of(0, 16384, -16384)], 16000));

  function stereo(): Uint8Array {
    const bytes = new Uint8Array(encodeWav([Int16Array.of(1, 2)], 16000));
    new DataView(bytes.buffer).setUint16(22, 2, true);
    return bytes;
  }

  function transcriber(impl: RecordingTranscriber = async () => ({ text: ' Hallo \n' })) {
    return vi.fn(impl);
  }

  it('hands decoded samples and the two-letter language to transcribe and returns the trimmed text', async () => {
    const transcribe = transcriber();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe });
    const response = await handler(request({ body: pcm(), query: '?language=de-DE' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hallo' });
    const [audio, options] = transcribe.mock.calls[0]!;
    expect(audio.samples).toBeInstanceOf(Float32Array);
    expect(Array.from(audio.samples)).toEqual([0, 0.5, -0.5]);
    expect(audio.sampleRate).toBe(16000);
    expect(options.language).toBe('de');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the auth, content type, language and size checks', async () => {
    const transcribe = transcriber();
    const refused = createRecordingTranscriptionHandler({ authorize: async () => false, transcribe });
    expect((await refused(request({ body: pcm() }))).status).toBe(401);
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe, maxBytes: 48 });
    expect((await handler(request({ body: pcm(), type: 'audio/webm' }))).status).toBe(415);
    expect((await handler(request({ body: pcm(), query: '?language=xx' }))).status).toBe(400);
    expect((await handler(request({ body: new Uint8Array(0) }))).status).toBe(400);
    expect((await handler(request({ body: new Uint8Array(49) }))).status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('answers 415 for a wav the local transcriber cannot read', async () => {
    const transcribe = transcriber();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe });
    expect((await handler(request({ body: stereo() }))).status).toBe(415);
    expect((await handler(request({ body: wav() }))).status).toBe(415);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('answers 503 when the transcriber is busy', async () => {
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({
      authorize: allow,
      transcribe: transcriber(async () => { throw new TranscriptionUnavailableError('busy'); }),
      onError,
    });
    const response = await handler(request({ body: pcm() }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Speech service busy' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the busy check duck-typed', async () => {
    const busy = Object.assign(new Error('busy'), { name: 'TranscriptionUnavailableError' });
    const handler = createRecordingTranscriptionHandler({
      authorize: allow,
      transcribe: transcriber(async () => { throw busy; }),
    });
    expect((await handler(request({ body: pcm() }))).status).toBe(503);
    expect(new TranscriptionUnavailableError('x').name).toBe('TranscriptionUnavailableError');
  });

  it('answers 502 and logs when the transcriber fails', async () => {
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({
      authorize: allow,
      transcribe: transcriber(async () => { throw new Error('boom'); }),
      onError,
    });
    const response = await handler(request({ body: pcm() }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Transcription failed' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('aborts the transcriber when the request is aborted', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const transcribe = transcriber(({ samples: _samples }, { signal }) => {
      received = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe, onError });
    const pending = handler(new Request('http://app.test/api/ai/speech-recognize', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: pcm() as BodyInit,
      signal: controller.signal,
    }));
    await running;
    expect(received!.aborted).toBe(false);
    controller.abort();
    expect(received!.aborted).toBe(true);
    // The client is gone: no server error, no log line.
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: 'Client closed request' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('defaults the local timeout to 120 seconds', async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const transcribe = transcriber((_audio, { signal }) => {
      received = signal;
      started();
      // Like the local transcriber: its own AbortError, not the signal's reason.
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Transcription aborted'), { name: 'AbortError' })), { once: true });
      });
    });
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe, onError });
    const pending = handler(request({ body: pcm() }));
    await running;
    await vi.advanceTimersByTimeAsync(119_999);
    expect(received!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(received!.aborted).toBe(true);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'Transcription timed out' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not accept a url and a transcriber together', () => {
    // @ts-expect-error url and transcribe exclude each other
    createRecordingTranscriptionHandler({
      authorize: allow,
      url: 'http://stt',
      transcribe: transcriber(),
    });
  });
});
