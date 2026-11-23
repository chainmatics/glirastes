/**
 * Worker entry of `glirastes/server/stt-local`. One per process; it loads the
 * model lazily on `load` and runs one job at a time with synchronous decodes,
 * so the main event loop never waits on native work. Cancellation arrives
 * through a SharedArrayBuffer flag read between chunks, because a running
 * synchronous decode blocks this thread's own message queue.
 *
 * Messages never carry audio or transcript content except the job's own
 * samples (in) and text (out).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createSherpaEngine, type EngineOptions, type SttEngine } from './engine.js';
import { SttLocalError } from './errors.js';
import { loadSherpa, readInstalledSherpaVersion } from './sherpa.js';

type InMessage =
  | { type: 'probe' }
  | { type: 'load' }
  | { type: 'job'; id: number; samples: Float32Array; cancel: Int32Array; deadline: number };

const port = parentPort;
if (!port) throw new Error('glirastes/server/stt-local worker must run in a worker thread');
const options = workerData as EngineOptions;
let engine: Promise<SttEngine> | undefined;

const codeOf = (error: unknown, fallback: string) => (error instanceof SttLocalError ? error.code : fallback);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');
// The main thread already reported platform and version warnings when it preloaded the addon.
const quiet = { onWarning: () => {} };

port.on('message', (message: InMessage) => {
  void handle(message);
});

async function handle(message: InMessage): Promise<void> {
  if (message.type === 'probe') {
    try {
      await loadSherpa(quiet);
      port!.postMessage({ type: 'probed', sherpaVersion: readInstalledSherpaVersion() ?? 'unknown' });
    } catch (error) {
      port!.postMessage({ type: 'error', code: codeOf(error, 'load_failed'), message: messageOf(error) });
    }
    return;
  }
  if (message.type === 'load') {
    try {
      engine ??= loadSherpa(quiet).then((sherpa) => createSherpaEngine(sherpa, options, 'sync'));
      await engine;
      port!.postMessage({ type: 'loaded' });
    } catch (error) {
      engine = undefined;
      port!.postMessage({ type: 'error', code: codeOf(error, 'load_failed'), message: messageOf(error) });
    }
    return;
  }
  const { id, samples, cancel, deadline } = message;
  try {
    if (!engine) throw new Error('model not loaded');
    const text = await (await engine).transcribe(samples, () => Atomics.load(cancel, 0) === 1 || Date.now() > deadline);
    port!.postMessage({ type: 'done', id, text });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') port!.postMessage({ type: 'aborted', id });
    else port!.postMessage({ type: 'error', id, message: messageOf(error) });
  }
}
