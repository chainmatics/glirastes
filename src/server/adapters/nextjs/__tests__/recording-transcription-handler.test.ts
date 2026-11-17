import { describe, expect, it, vi } from 'vitest';
import { createRecordingTranscriptionHandler, isPrivateServiceUrl, wavDurationSeconds } from '../recording-transcription-handler.js';

/** A 16 kHz mono 16-bit PCM WAV of the given length. */
function wav(seconds = 0.25): Uint8Array {
  const dataBytes = Math.round(seconds * 16_000) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
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
});
