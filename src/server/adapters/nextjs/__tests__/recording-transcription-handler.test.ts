import { describe, expect, it, vi } from 'vitest';
import { createRecordingTranscriptionHandler } from '../recording-transcription-handler.js';

const wav = (bytes = 8) => new Uint8Array(bytes).fill(1);

function request(options: { body?: Uint8Array; type?: string; query?: string } = {}) {
  return new Request(`http://app.test/api/ai/speech-recognize${options.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': options.type ?? 'audio/wav' },
    body: options.body ?? wav(),
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
