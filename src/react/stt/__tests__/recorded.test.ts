import { describe, expect, it, vi } from 'vitest';
import { RecordedSttAdapter, encodeWav } from '../recorded.js';

function setup(options: {
  response?: () => Response | Promise<Response>;
  maxSeconds?: number;
} = {}) {
  let feed: (audio: ArrayBuffer) => void = () => {};
  const closeCapture = vi.fn(async () => {});
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => (
    options.response ? options.response() : new Response(JSON.stringify({ text: ' Hallo Welt ' }), { status: 200 })
  ));
  const adapter = new RecordedSttAdapter({
    url: 'https://app.test/api/ai/speech-recognize',
    fetch: fetchImpl as unknown as typeof fetch,
    maxSeconds: options.maxSeconds,
    capture: async (_stream, onAudio) => { feed = onAudio; return closeCapture; },
  });
  const events = { onSegment: vi.fn(), onError: vi.fn(), onClosed: vi.fn() };
  const controller = new AbortController();
  const connect = () => adapter.connect({
    stream: {} as MediaStream, language: 'de', signal: controller.signal, events,
  });
  const samples = (count: number) => new Int16Array(count).fill(1000).buffer;
  return { connect, events, fetchImpl, closeCapture, controller, feed: (count: number) => feed(samples(count)) };
}

describe('RecordedSttAdapter', () => {
  it('sends the recording as one WAV when it ends and reports the text as a final segment', async () => {
    const t = setup();
    const connection = await t.connect();
    t.feed(8_000);
    t.feed(8_000);
    expect(t.fetchImpl).not.toHaveBeenCalled();

    await connection.finalize();

    expect(t.closeCapture).toHaveBeenCalledTimes(1);
    const [url, init] = t.fetchImpl.mock.calls[0];
    expect(url).toBe('https://app.test/api/ai/speech-recognize?language=de');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('audio/wav');
    const wav = new DataView(init.body as ArrayBuffer);
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe('RIFF');
    expect(wav.getUint32(24, true)).toBe(16_000); // sample rate
    expect(wav.getUint16(22, true)).toBe(1); // mono
    expect(wav.getUint32(40, true)).toBe(32_000); // one second of 16-bit samples
    expect(wav.getInt16(44, true)).toBe(1000);
    expect(t.events.onSegment).toHaveBeenCalledWith({ id: 'recording', sequence: 0, text: 'Hallo Welt', isFinal: true });
    expect(t.events.onError).not.toHaveBeenCalled();
  });

  it('asks nothing of the server for an empty recording', async () => {
    const t = setup();
    const connection = await t.connect();
    await connection.finalize();
    expect(t.fetchImpl).not.toHaveBeenCalled();
    expect(t.events.onSegment).not.toHaveBeenCalled();
  });

  it('reports a failed transcription without passing the server text on', async () => {
    const t = setup({ response: () => new Response('secret upstream detail', { status: 502 }) });
    const connection = await t.connect();
    t.feed(1_600);
    await connection.finalize();
    expect(t.events.onSegment).not.toHaveBeenCalled();
    expect(t.events.onError).toHaveBeenCalledTimes(1);
    expect(String(t.events.onError.mock.calls[0][0].message)).toBe('Transcription failed');
  });

  it('discards the recording when cancelled', async () => {
    const t = setup();
    const connection = await t.connect();
    t.feed(1_600);
    await connection.cancel();
    await connection.finalize();
    expect(t.closeCapture).toHaveBeenCalledTimes(1);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('stops keeping audio at the length limit and still transcribes what it has', async () => {
    const t = setup({ maxSeconds: 1 });
    const connection = await t.connect();
    t.feed(12_000);
    t.feed(12_000);
    t.feed(12_000);
    await connection.finalize();
    const wav = new DataView(t.fetchImpl.mock.calls[0][1].body as ArrayBuffer);
    expect(wav.getUint32(40, true)).toBe(32_000);
  });

  it('writes a canonical 16-bit mono header', () => {
    const wav = new DataView(encodeWav([new Int16Array([1, -1])], 16_000));
    expect(wav.byteLength).toBe(48);
    expect(wav.getUint32(4, true)).toBe(40);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(wav.getInt16(46, true)).toBe(-1);
  });
});
