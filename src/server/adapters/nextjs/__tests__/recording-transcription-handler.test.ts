import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../../../../react/stt/recorded.js';
import {
  createRecordingTranscriptionHandler,
  isPrivateServiceUrl,
  wavDurationSeconds,
  TranscriptionUnavailableError,
  type RecordingTranscriber,
} from '../recording-transcription-handler.js';

/** A 16 kHz mono 16-bit PCM WAV of the given length. */
function wav(seconds = 0.25, header: { byteRate?: number; blockAlign?: number; format?: number; sampleRate?: number } = {}): Uint8Array {
  const dataBytes = Math.round(seconds * 16_000) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, header.format ?? 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, header.sampleRate ?? 16_000, true); view.setUint32(28, header.byteRate ?? 32_000, true); view.setUint16(32, header.blockAlign ?? 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, dataBytes, true);
  return bytes;
}

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
  it('does not impose a privacy duration cap on an unprotected local transcriber', async () => {
    const transcribe = vi.fn(async () => ({ text: 'long ordinary recording' }));
    const handler = createRecordingTranscriptionHandler({ authorize: allow, transcribe });
    expect((await handler(request({ body: wav(100) }))).status).toBe(200);
    expect(transcribe).toHaveBeenCalledOnce();
  });
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
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service(), maxBytes: 10_000 });
    expect((await handler(request({ query: '?language=xx' }))).status).toBe(400);
    expect((await handler(request({ body: new Uint8Array(0) }))).status).toBe(400);
    expect((await handler(request({ body: wav(1) }))).status).toBe(413);
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

  it('refuses bytes that are not a WAV file and a recording longer than the limit', async () => {
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, maxDurationSeconds: 1 });
    expect((await handler(request({ body: new Uint8Array(64).fill(1) }))).status).toBe(415);
    expect((await handler(request({ body: wav(1.5) }))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    expect(wavDurationSeconds(wav(2))).toBe(2);
  });

  it('stops reading a body larger than the limit without holding all of it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(4096)); if (pulled > 1000) controller.close(); },
    });
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service(), maxBytes: 8192 });
    const response = await handler(new Request('http://app.test/api/ai/speech-recognize', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body, duplex: 'half' } as RequestInit));
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('measures the duration from sample rate, channels and bits, not from a claimed byte rate', async () => {
    // 150 s of 16 kHz mono 16-bit audio whose header claims 4,000,000 bytes per second.
    const lying = wav(150, { byteRate: 4_000_000 });
    expect(wavDurationSeconds(lying)).toBeUndefined();
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, maxDurationSeconds: 60 });
    expect((await handler(request({ body: lying }))).status).toBe(415);
    // The same audio with an honest header is a plain too-long recording.
    expect(wavDurationSeconds(wav(150))).toBe(150);
    expect((await handler(request({ body: wav(150) }))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a header whose fields disagree and a format it cannot measure', async () => {
    expect(wavDurationSeconds(wav(2, { blockAlign: 4 }))).toBeUndefined();
    expect(wavDurationSeconds(wav(2, { byteRate: 16_000 }))).toBeUndefined();
    expect(wavDurationSeconds(wav(2, { format: 3 }))).toBeUndefined(); // IEEE float
    expect(wavDurationSeconds(wav(2, { format: 0x55 }))).toBeUndefined(); // MP3 in WAV
    expect(wavDurationSeconds(wav(2, { sampleRate: 0, byteRate: 0 }))).toBeUndefined();
    expect(wavDurationSeconds(wav(2))).toBe(2);
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch });
    expect((await handler(request({ body: wav(2, { format: 3 }) }))).status).toBe(415);
    expect((await handler(request({ body: wav(2) }))).status).toBe(200);
  });

  it('counts audio after the data chunk against the duration', () => {
    const base = wav(1);
    const padded = new Uint8Array(base.byteLength + 64_000); // 2 s more bytes after a 1 s data chunk
    padded.set(base);
    expect(wavDurationSeconds(padded)).toBe(3);
  });

  it('reads the body under the concurrency cap: a waiting upload is not read at all', async () => {
    let release!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) { release = () => { controller.enqueue(wav()); controller.close(); }; },
    });
    let secondPulled = 0;
    const second = new ReadableStream<Uint8Array>({ pull(controller) { secondPulled += 1; controller.enqueue(wav()); controller.close(); } }, { highWaterMark: 0 });
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service(), maxConcurrent: 1, maxQueued: 0 });
    const init = (body: ReadableStream<Uint8Array>) => ({ method: 'POST', headers: { 'content-type': 'audio/wav' }, body, duplex: 'half' } as RequestInit);
    const first = handler(new Request('http://app.test/api/ai/speech-recognize', init(slow)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rejected = await handler(new Request('http://app.test/api/ai/speech-recognize', init(second)));
    expect(rejected.status).toBe(429);
    expect(secondPulled).toBe(0);
    release();
    expect((await first).status).toBe(200);
  });

  it('cuts off an upload that is too slow, within the timeout', async () => {
    const onError = vi.fn();
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const fetch = service();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, timeoutMs: 50, onError });
    const response = await handler(new Request('http://app.test/api/ai/speech-recognize', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: stalled, duplex: 'half' } as RequestInit));
    expect(response.status).toBe(408);
    expect(cancelled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'upload_timeout' }));
  });

  it('treats a missing or invalid transcript as a failure, not as silence', async () => {
    for (const answer of [{}, { text: 42 }, 'not json']) {
      const onError = vi.fn();
      const handler = createRecordingTranscriptionHandler({
        authorize: allow, url: 'http://stt', onError,
        fetch: service(() => (typeof answer === 'string' ? new Response(answer) : Response.json(answer))),
      });
      expect((await handler(request())).status).toBe(502);
      expect(onError).toHaveBeenCalledOnce();
    }
    const silence = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch: service(() => Response.json({ text: '' })) });
    expect(await (await silence(request())).json()).toEqual({ text: '' });
  });

  it('never follows a redirect and logs no transcript or audio', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')); });
    try {
      const fetch = service(() => new Response(null, { status: 302, headers: { location: 'https://cloud.example.invalid' } }));
      const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch });
      expect((await handler(request())).status).toBe(502);
      expect(fetch.mock.calls[0]![1]!.redirect).toBe('manual');
      const failing = createRecordingTranscriptionHandler({
        authorize: allow, url: 'http://stt',
        fetch: service(() => { throw new Error('Anna Muster sagte: Hallo'); }),
      });
      expect((await failing(request())).status).toBe(502);
      expect(lines.join('\n')).not.toMatch(/Anna|Hallo|cloud\.example/);
      expect(lines.join('\n')).toContain('service_status_302');
    } finally {
      spy.mockRestore();
    }
  });

  it('in the protected profile only sends audio to a private service address', async () => {
    const fetch = service();
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'https://api.deepgram.com', fetch, localOnly: true, onError });
    expect((await handler(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'service_not_local' }));
    for (const ok of ['http://stt:8000', 'http://localhost:9000', 'http://10.0.3.7', 'http://172.20.0.5:80', 'http://192.168.1.2', 'http://stt.internal', 'http://[fd00::1]:8000', 'http://whisper.svc.cluster.local']) {
      expect(isPrivateServiceUrl(ok), ok).toBe(true);
    }
    for (const bad of ['https://api.openai.com', 'http://8.8.8.8', 'http://172.32.0.1', 'ftp://stt', 'http://user:pw@stt', 'http://stt.example.com', 'not a url']) {
      expect(isPrivateServiceUrl(bad), bad).toBe(false);
    }
  });

  it('runs two transcriptions at once, queues the next and answers 429 beyond the queue', async () => {
    const pending: Array<() => void> = [];
    const fetch = service(() => new Promise<Response>((resolve) => { pending.push(() => resolve(Response.json({ text: 'ok' }))); }));
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, maxConcurrent: 2, maxQueued: 1 });
    const running = [handler(request()), handler(request()), handler(request())];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const rejected = await handler(request());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('5');
    pending.shift()!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    while (pending.length) pending.shift()!();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('cancels the service call when the browser aborts', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const onError = vi.fn();
    const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, onError });
    const body = wav();
    const pendingResponse = handler(new Request('http://app.test/api/ai/speech-recognize', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: body as BodyInit, signal: controller.signal }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect((await pendingResponse).status).toBe(499);
    expect(seen?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  describe('privacy policy per request', () => {
    it('forces localOnly for a protected policy although the option is off', async () => {
      const fetch = service();
      const onError = vi.fn();
      const handler = createRecordingTranscriptionHandler({
        authorize: allow, url: 'https://api.deepgram.com', fetch, onError,
        policy: () => ({ localOnly: true, maxDurationSeconds: 60 }),
      });
      expect((await handler(request())).status).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'service_not_local' }));
    });

    it('caps the duration at the shorter limit', async () => {
      const fetch = service();
      const handler = createRecordingTranscriptionHandler({
        authorize: allow, url: 'http://stt', fetch, maxDurationSeconds: 60,
        policy: () => ({ localOnly: true, maxDurationSeconds: 1 }),
      });
      expect((await handler(request({ body: wav(2) }))).status).toBe(413);
      expect((await handler(request({ body: wav(0.5) }))).status).toBe(200);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('reads the policy per request', async () => {
      let limit = 5;
      const handler = createRecordingTranscriptionHandler({
        authorize: allow, url: 'http://stt', fetch: service(),
        policy: () => ({ localOnly: true, maxDurationSeconds: limit }),
      });
      expect((await handler(request({ body: wav(2) }))).status).toBe(200);
      limit = 1;
      expect((await handler(request({ body: wav(2) }))).status).toBe(413);
    });

    it('answers 503 without reading the audio when the policy is unavailable, missing or malformed', async () => {
      for (const policy of [
        () => { throw new Error('privacy_policy_unavailable'); },
        // A wired resolver that answers nothing is no explicit `off`.
        () => null,
        () => undefined,
        () => 'OFF' as never,
        () => ({ localOnly: false, maxDurationSeconds: 60 }) as never,
        () => ({ localOnly: true, maxDurationSeconds: 0 }),
        () => ({ localOnly: true }) as never,
        () => 'protected' as never,
      ]) {
        const fetch = service();
        const onError = vi.fn();
        const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'http://stt', fetch, onError, policy: policy as never });
        const body = request();
        const response = await handler(body);
        expect(response.status).toBe(503);
        expect(body.bodyUsed).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'policy_unavailable' }));
        expect(JSON.stringify(onError.mock.calls)).not.toContain('privacy_policy_unavailable');
      }
    });

    it('keeps the configured behaviour only for an explicit off', async () => {
      const fetch = service();
      const handler = createRecordingTranscriptionHandler({
        authorize: allow, url: 'https://stt.example.com', fetch, policy: () => 'off',
      });
      expect((await handler(request())).status).toBe(200);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('keeps the configured behaviour without any privacy integration', async () => {
      const fetch = service();
      const handler = createRecordingTranscriptionHandler({ authorize: allow, url: 'https://stt.example.com', fetch });
      expect((await handler(request())).status).toBe(200);
    });

    it('checks the session before the policy', async () => {
      const policy = vi.fn(() => ({ localOnly: true as const, maxDurationSeconds: 60 }));
      const handler = createRecordingTranscriptionHandler({ authorize: async () => false, url: 'http://stt', fetch: service(), policy });
      expect((await handler(request())).status).toBe(401);
      expect(policy).not.toHaveBeenCalled();
    });
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
    expect((await handler(request({ body: new Uint8Array([82, 73, 70, 70]) }))).status).toBe(415);
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
