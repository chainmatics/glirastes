import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttSessionController, type SttProviderAdapter } from '../controller.js';
import { createPcmPipeline, DeepgramSttAdapter } from '../deepgram.js';
import { RecordedSttAdapter } from '../recorded.js';
import { AudioWorkletLoadError, isAudioWorkletLoadError } from '../worklet-error.js';

const originalAudioContext = globalThis.AudioContext;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: originalAudioContext });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: originalAudioWorkletNode });
});

function stubAudio(addModule: (url: string) => Promise<void>) {
  const close = vi.fn(async () => {});
  const context = {
    audioWorklet: { addModule: vi.fn(addModule) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    destination: {},
    close,
  };
  class TestAudioContext {
    constructor(_options: AudioContextOptions) {
      return context;
    }
  }
  class TestAudioWorkletNode {
    readonly port = { onmessage: null };
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    constructor(_context: AudioContext, _name: string) {}
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: TestAudioContext });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: TestAudioWorkletNode });
  return context;
}

describe('a worklet that does not load', () => {
  it('rejects with AudioWorkletLoadError, logs the URL with console.error and closes the context', async () => {
    const cause = new DOMException('Unable to load a worklet', 'AbortError');
    const context = stubAudio(async () => { throw cause; });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = await createPcmPipeline({} as MediaStream, vi.fn(), { workletUrl: '/missing/pcm.js' })
      .catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(AudioWorkletLoadError);
    expect(isAudioWorkletLoadError(failure)).toBe(true);
    expect((failure as AudioWorkletLoadError).url).toBe('/missing/pcm.js');
    expect((failure as AudioWorkletLoadError).cause).toBe(cause);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('/missing/pcm.js');
    expect(String(error.mock.calls[0]![0])).toContain('glirastes stt worklet');
    expect(error.mock.calls[0]![1]).toBe(cause);
    expect(context.close).toHaveBeenCalled();
  });

  it('marks the failed session with the audio-worklet-unavailable code', async () => {
    stubAudio(async () => { throw new Error('404'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new SttSessionController({
      adapter: new RecordedSttAdapter({ fetch: vi.fn() as unknown as typeof fetch }),
      language: 'de',
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
    });

    await expect(controller.start('')).rejects.toBeInstanceOf(AudioWorkletLoadError);
    expect(controller.snapshot.phase).toBe('failed');
    expect(controller.snapshot.errorCode).toBe('audio-worklet-unavailable');
  });

  it('leaves the code empty for other failures', async () => {
    const controller = new SttSessionController({
      adapter: { connect: async () => { throw new Error('denied'); } },
      language: 'de',
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
    });
    await expect(controller.start('')).rejects.toThrow('denied');
    expect(controller.snapshot.phase).toBe('failed');
    expect(controller.snapshot.errorCode ?? null).toBeNull();
  });
});

describe('the worklet URL of a session', () => {
  it('reaches the adapter through connect()', async () => {
    const connect = vi.fn<SttProviderAdapter['connect']>(async () => ({
      finalize: async () => {}, cancel: async () => {}, close: async () => {},
    }));
    const controller = new SttSessionController({
      adapter: { connect },
      language: 'de',
      workletUrl: '/static/pcm.js',
      getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
    });
    await controller.start('');
    expect(connect.mock.calls[0]![0].workletUrl).toBe('/static/pcm.js');
  });

  it('is used by RecordedSttAdapter without its own workletUrl, and its own option wins', async () => {
    const context = stubAudio(async () => {});
    const input = (workletUrl?: string) => ({
      stream: {} as MediaStream,
      language: 'de',
      signal: new AbortController().signal,
      events: { onSegment: vi.fn(), onError: vi.fn(), onClosed: vi.fn() },
      workletUrl,
    });
    await (await new RecordedSttAdapter().connect(input('/chat/pcm.js'))).close();
    expect(context.audioWorklet.addModule).toHaveBeenLastCalledWith('/chat/pcm.js');
    await (await new RecordedSttAdapter({ workletUrl: '/own/pcm.js' }).connect(input('/chat/pcm.js'))).close();
    expect(context.audioWorklet.addModule).toHaveBeenLastCalledWith('/own/pcm.js');
  });

  it('is declared as accepted by the built-in adapters', () => {
    expect(new RecordedSttAdapter().acceptsWorkletUrl).toBe(true);
    expect(new DeepgramSttAdapter().acceptsWorkletUrl).toBe(true);
    // A custom capture does not load the worklet.
    expect(new RecordedSttAdapter({ capture: async () => async () => {} }).acceptsWorkletUrl).toBe(false);
  });
});
