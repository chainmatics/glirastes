import { Worker } from 'node:worker_threads';
import {
  TranscriptionUnavailableError,
  type RecordingTranscriber,
} from '../adapters/nextjs/recording-transcription-handler.js';
import { abortError, createSherpaEngine, type EngineOptions, type SttEngine } from './engine.js';
import { checkModelFiles, resolveSttModelDir } from './models.js';
import { checkSttPlatform, currentSttPlatform, type SttPlatformInfo } from './platform.js';
import { loadSherpa, type LoadSherpaOptions } from './sherpa.js';
import type { SherpaModule } from './sherpa-types.js';
import { WorkerHost, type WorkerLike } from './worker-host.js';

export interface LocalTranscriberOptions {
  /** Default `resolveSttModelDir()`: `GLIRASTES_MODEL_DIR`, else the XDG cache, else `~/.cache/glirastes/models`. */
  modelDir?: string;
  /** ONNX Runtime threads per decode. Default 2, integer 1–16. */
  numThreads?: number;
  /** `worker` (default) decodes on one worker thread; `inline` uses the async API on the libuv threadpool, without a hard stop. */
  mode?: 'worker' | 'inline';
  /** Jobs allowed to wait behind the running one; more answer 503. Default 4. */
  maxQueue?: number;
  /** How long a cancelled job may take before its worker is terminated. Default 5000 ms. */
  hardStopGraceMs?: number;
  /** Receives platform and version warnings. Default `console.warn`. */
  onWarning?: (message: string) => void;
}

export interface LocalTranscriber {
  /** Bound; pass it as `transcribe: stt.transcribe` to `createRecordingTranscriptionHandler`. */
  transcribe: RecordingTranscriber;
  /** Platform check, peer load, model files check and model load. Call it at server start to avoid a slow first request. */
  warmup(): Promise<void>;
  /** Terminates the worker and removes this instance from the process registry. */
  close(): Promise<void>;
}

export interface LocalSttCheck {
  platform: string;
  arch: string;
  glibc?: string;
  sherpaVersion: string;
  workerRestarts: 1;
}

/** Internal seams; the public functions pass the real implementations. */
export interface LocalTranscriberDeps {
  platform: () => SttPlatformInfo;
  loadSherpa: (options: LoadSherpaOptions) => Promise<SherpaModule>;
  checkModelFiles: (modelDir: string) => Promise<void>;
  spawn: (workerData: EngineOptions) => WorkerLike;
  createEngine: (sherpa: SherpaModule, options: EngineOptions, decode: 'async') => Promise<SttEngine>;
  installedVersion?: () => string | undefined;
}

const defaultDeps: LocalTranscriberDeps = {
  platform: currentSttPlatform,
  loadSherpa,
  checkModelFiles: (modelDir) => checkModelFiles(modelDir),
  spawn: (workerData) => new Worker(new URL('./worker.js', import.meta.url), { workerData }) as unknown as WorkerLike,
  createEngine: createSherpaEngine,
};

const REGISTRY = Symbol.for('glirastes.stt-local');

/** Process-wide, so a module re-evaluated by Next.js dev HMR reuses the loaded model instead of a second 1.2 GB worker. */
function registry(): Map<string, LocalTranscriber> {
  const scope = globalThis as Record<symbol, Map<string, LocalTranscriber> | undefined>;
  scope[REGISTRY] ??= new Map();
  return scope[REGISTRY];
}

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
  return value;
}

/** Internal: `createLocalTranscriber` with injectable seams. */
export function createLocalTranscriberWith(deps: LocalTranscriberDeps, options: LocalTranscriberOptions = {}): LocalTranscriber {
  const numThreads = integer('numThreads', options.numThreads ?? 2, 1, 16);
  const maxQueue = integer('maxQueue', options.maxQueue ?? 4, 0, Number.MAX_SAFE_INTEGER);
  const hardStopGraceMs = integer('hardStopGraceMs', options.hardStopGraceMs ?? 5000, 0, Number.MAX_SAFE_INTEGER);
  const mode = options.mode ?? 'worker';
  if (mode !== 'worker' && mode !== 'inline') throw new RangeError(`mode must be 'worker' or 'inline', got ${String(mode)}`);
  const modelDir = options.modelDir ?? resolveSttModelDir();
  const key = JSON.stringify([modelDir, numThreads, mode]);
  const existing = registry().get(key);
  if (existing) return existing;

  const engineOptions: EngineOptions = { modelDir, numThreads };
  const sherpaOptions = (): LoadSherpaOptions => ({
    platform: deps.platform(),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    ...(deps.installedVersion ? { installedVersion: deps.installedVersion } : {}),
  });

  /** Platform, peer and model files, once; a failure is retried on the next call. */
  let checked: Promise<SherpaModule> | undefined;
  const check = () => {
    checked ??= (async () => {
      checkSttPlatform(deps.platform());
      const sherpa = await deps.loadSherpa(sherpaOptions());
      await deps.checkModelFiles(modelDir);
      return sherpa;
    })().catch((error: unknown) => {
      checked = undefined;
      throw error;
    });
    return checked;
  };

  let host: WorkerHost | undefined;
  let engine: Promise<SttEngine> | undefined;
  const workerHost = () => {
    host ??= new WorkerHost({
      spawn: () => deps.spawn(engineOptions),
      // check() loads the addon on the main thread, before the first spawn.
      preload: async () => { await check(); },
      maxQueue,
      hardStopGraceMs,
    });
    return host;
  };
  const inlineEngine = async () => {
    const sherpa = await check();
    engine ??= deps.createEngine(sherpa, engineOptions, 'async').catch((error: unknown) => {
      engine = undefined;
      throw error;
    });
    return engine;
  };

  // Inline mode: one job at a time, the same bounded queue as the worker.
  let inlineTail: Promise<unknown> = Promise.resolve();
  let inlinePending = 0;
  const runInline = (samples: Float32Array, signal: AbortSignal): Promise<string> => {
    if (signal.aborted) return Promise.reject(abortError());
    if (inlinePending > maxQueue) return Promise.reject(new TranscriptionUnavailableError('The local speech recognizer is busy'));
    inlinePending += 1;
    const job = inlineTail.then(async () => {
      if (signal.aborted) throw abortError();
      return (await inlineEngine()).transcribe(samples, () => signal.aborted);
    });
    const done = job.finally(() => { inlinePending -= 1; });
    inlineTail = done.catch(() => undefined);
    return done;
  };

  const transcriber: LocalTranscriber = {
    async warmup() {
      await check();
      if (mode === 'inline') await inlineEngine();
      else await workerHost().load();
    },
    // Parakeet detects the language itself; the handler has already validated it.
    transcribe: async (audio, { signal }) => {
      if (mode === 'inline') return { text: await runInline(audio.samples, signal) };
      await check();
      return { text: await workerHost().run(audio.samples, signal, Infinity) };
    },
    async close() {
      if (registry().get(key) === transcriber) registry().delete(key);
      engine = undefined;
      await host?.close();
    },
  };
  registry().set(key, transcriber);
  return transcriber;
}

/**
 * Transcribes recordings in this Node process with Parakeet TDT 0.6b v3 int8
 * through the optional peer `sherpa-onnx-node` 2.0.1, using the models that
 * `glirastes stt pull` downloaded. Nothing is downloaded at runtime and no
 * audio leaves the process. One instance per model dir, threads and mode in
 * a process; later calls with the same values return it.
 */
export function createLocalTranscriber(options: LocalTranscriberOptions = {}): LocalTranscriber {
  return createLocalTranscriberWith(defaultDeps, options);
}

/** Internal: `checkLocalStt` with injectable seams. */
export async function checkLocalSttWith(
  deps: LocalTranscriberDeps,
  options: Pick<LocalTranscriberOptions, 'onWarning'>,
): Promise<LocalSttCheck> {
  const platform = deps.platform();
  checkSttPlatform(platform);
  const sherpaOptions: LoadSherpaOptions = {
    platform,
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    ...(deps.installedVersion ? { installedVersion: deps.installedVersion } : {}),
  };
  await deps.loadSherpa(sherpaOptions);
  const host = new WorkerHost({
    spawn: () => deps.spawn({ modelDir: '', numThreads: 1 }),
    preload: async () => {},
    maxQueue: 0,
    hardStopGraceMs: 5000,
  });
  try {
    await host.probe();
    await host.close();
    const sherpaVersion = await host.probe();
    return {
      platform: platform.platform,
      arch: platform.arch,
      ...(platform.glibcVersionRuntime ? { glibc: platform.glibcVersionRuntime } : {}),
      sherpaVersion,
      workerRestarts: 1,
    };
  } finally {
    await host.close();
  }
}

/**
 * A model-free readiness check for deploys: platform check, the addon on the
 * main thread, a worker that loads the addon, a worker restart and a second
 * probe (the restart that fails on linux-arm64 without the main-thread preload).
 */
export function checkLocalStt(options: Pick<LocalTranscriberOptions, 'onWarning'> = {}): Promise<LocalSttCheck> {
  return checkLocalSttWith(defaultDeps, options);
}
