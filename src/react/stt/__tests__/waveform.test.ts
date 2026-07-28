import { describe, expect, it, vi } from 'vitest';
import { createStreamAnalyser } from '../waveform.js';

describe('STT waveform analyser', () => {
  it('analyses the authoritative recording stream without requesting another one', async () => {
    const stream = {} as MediaStream;
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const analyser = {
      fftSize: 0,
      frequencyBinCount: 4,
      getByteTimeDomainData: vi.fn((values: Uint8Array) => {
        values.set([128, 160, 96, 128]);
      }),
      disconnect: vi.fn(),
    };
    const context = {
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      close: vi.fn(async () => {}),
    };

    const meter = createStreamAnalyser(
      stream,
      () => context as unknown as AudioContext,
    );

    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(meter.readLevel()).toBeGreaterThan(0);

    await meter.close();
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
