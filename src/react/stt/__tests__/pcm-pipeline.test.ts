import { afterEach, expect, it, vi } from 'vitest';
import { createPcmPipeline } from '../deepgram.js';

afterEach(() => vi.unstubAllGlobals());
function audio(addModule = vi.fn(async (_url: string) => {})) {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const processor = { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { audioWorklet: { addModule }, close: vi.fn(async () => {}), createMediaStreamSource: () => source, destination: {} };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('AudioWorkletNode', class { constructor() { return processor; } });
  return { context, processor, source };
}
it('loads a configured hosting path and closes the pipeline once', async () => {
  const t = audio();
  const stop = await createPcmPipeline({} as MediaStream, vi.fn(), '/fieldwork/assets/pcm.js');
  expect(t.context.audioWorklet.addModule).toHaveBeenCalledWith('/fieldwork/assets/pcm.js');
  await stop(); await stop();
  expect(t.context.close).toHaveBeenCalledTimes(1);
  expect(t.processor.port.onmessage).toBeNull();
});
it('closes AudioContext and identifies the missing asset with a repair hint', async () => {
  const t = audio(vi.fn(async () => { throw new Error('404'); }));
  await expect(createPcmPipeline({} as MediaStream, vi.fn(), '/base/pcm.js')).rejects.toThrow(/\/base\/pcm.js.*glirastes\/stt\/audio-worklet-processor.js/);
  expect(t.context.close).toHaveBeenCalledTimes(1);
});
