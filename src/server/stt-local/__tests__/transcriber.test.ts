import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttLocalError } from '../errors.js';
import type { SttPlatformInfo } from '../platform.js';
import type { SttEngine } from '../engine.js';
import type { SherpaModule } from '../sherpa-types.js';
import {
  checkLocalSttWith,
  createLocalTranscriberWith,
  type LocalTranscriberDeps,
} from '../transcriber.js';
import { FakeWorker, tick } from './fake-worker.js';

const REGISTRY = Symbol.for('glirastes.stt-local');
const darwin: SttPlatformInfo = { platform: 'darwin', arch: 'arm64' };
const musl: SttPlatformInfo = { platform: 'linux', arch: 'x64' };

function deps(overrides: Partial<LocalTranscriberDeps> = {}) {
  const workers: FakeWorker[] = [];
  const order: string[] = [];
  const sherpa = { OfflineRecognizer: class {}, Vad: class {} } as unknown as SherpaModule;
  const engine = { transcribe: vi.fn<SttEngine['transcribe']>(async () => 'hallo') };
  const base: LocalTranscriberDeps = {
    platform: () => darwin,
    loadSherpa: vi.fn(async () => { order.push('sherpa'); return sherpa; }),
    checkModelFiles: vi.fn(async () => { order.push('models'); }),
    spawn: vi.fn(() => {
      order.push('spawn');
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }),
    createEngine: vi.fn(async () => { order.push('engine'); return engine; }),
    installedVersion: () => '2.0.1',
  };
  return { deps: { ...base, ...overrides }, workers, order, engine, sherpa };
}

const audio = () => ({ samples: new Float32Array(16).fill(0.3), sampleRate: 16000 as const });
const options = (signal = new AbortController().signal) => ({ language: 'de', signal });

async function answerLoad(workers: FakeWorker[], index = 0) {
  for (let i = 0; i < 5 && !workers[index]?.posted.some((m) => m.type === 'load'); i += 1) await tick();
  workers[index]!.reply({ type: 'loaded' });
  await tick();
}

describe('createLocalTranscriber', () => {
  afterEach(() => {
    (globalThis as Record<symbol, Map<string, unknown> | undefined>)[REGISTRY]?.clear();
  });

  it('reuses one instance per model dir, threads and mode in a process', async () => {
    const { deps: d } = deps();
    const a = createLocalTranscriberWith(d, { modelDir: '/models' });
    const b = createLocalTranscriberWith(d, { modelDir: '/models', numThreads: 2, mode: 'worker' });
    const c = createLocalTranscriberWith(d, { modelDir: '/models', numThreads: 4 });
    const e = createLocalTranscriberWith(d, { modelDir: '/models', mode: 'inline' });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(e).not.toBe(a);
    await a.close();
    expect(createLocalTranscriberWith(d, { modelDir: '/models' })).not.toBe(a);
  });

  it('warmup checks platform, peer and model files before loading', async () => {
    const { deps: d, workers, order } = deps();
    const stt = createLocalTranscriberWith(d, { modelDir: '/models' });
    const warm = stt.warmup();
    await answerLoad(workers);
    await warm;
    expect(order).toEqual(['sherpa', 'models', 'spawn']);
    expect(d.checkModelFiles).toHaveBeenCalledWith('/models');
    await stt.close();
  });

  it('refuses a missing model file before any worker starts', async () => {
    const { deps: d } = deps({
      checkModelFiles: vi.fn(async () => { throw new SttLocalError('models_missing', 'x missing. Run: glirastes stt pull'); }),
    });
    const stt = createLocalTranscriberWith(d, { modelDir: '/models' });
    await expect(stt.warmup()).rejects.toMatchObject({ code: 'models_missing' });
    await expect(stt.transcribe(audio(), options())).rejects.toMatchObject({ code: 'models_missing' });
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('refuses musl before any import or spawn', async () => {
    const { deps: d } = deps({ platform: () => musl });
    const stt = createLocalTranscriberWith(d, { modelDir: '/models' });
    await expect(stt.warmup()).rejects.toMatchObject({ code: 'platform_unsupported' });
    expect(d.loadSherpa).not.toHaveBeenCalled();
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('rejects numThreads outside 1–16 synchronously', () => {
    const { deps: d } = deps();
    for (const numThreads of [0, 17, 1.5, Number.NaN]) {
      expect(() => createLocalTranscriberWith(d, { modelDir: '/m', numThreads })).toThrow(RangeError);
    }
    expect(() => createLocalTranscriberWith(d, { modelDir: '/m', maxQueue: -1 })).toThrow(RangeError);
    expect(() => createLocalTranscriberWith(d, { modelDir: '/m', hardStopGraceMs: -1 })).toThrow(RangeError);
  });

  it('transcribes on the worker with no deadline of its own', async () => {
    const { deps: d, workers } = deps();
    const stt = createLocalTranscriberWith(d, { modelDir: '/models' });
    const result = stt.transcribe(audio(), options());
    await answerLoad(workers);
    const job = workers[0]!.jobs()[0]!;
    expect(job.deadline).toBe(Infinity);
    expect(d.spawn).toHaveBeenCalledWith({ modelDir: '/models', numThreads: 2 });
    workers[0]!.reply({ type: 'done', id: job.id, text: ' Hallo ' });
    expect(await result).toEqual({ text: ' Hallo ' });
    await stt.close();
  });

  it('inline mode uses the async engine and no worker', async () => {
    const { deps: d, engine, sherpa } = deps();
    const stt = createLocalTranscriberWith(d, { modelDir: '/models', mode: 'inline', numThreads: 3 });
    expect(await stt.transcribe(audio(), options())).toEqual({ text: 'hallo' });
    expect(d.createEngine).toHaveBeenCalledOnce();
    expect(d.createEngine).toHaveBeenCalledWith(sherpa, { modelDir: '/models', numThreads: 3 }, 'async');
    expect(d.spawn).not.toHaveBeenCalled();
    expect(engine.transcribe).toHaveBeenCalledOnce();
  });

  it('inline mode stops between chunks when the request aborts and bounds its queue', async () => {
    const { deps: d, engine } = deps();
    let release!: () => void;
    const controller = new AbortController();
    engine.transcribe.mockImplementationOnce(async (_samples: Float32Array, shouldStop: () => boolean) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (shouldStop()) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return 'never';
    });
    const stt = createLocalTranscriberWith(d, { modelDir: '/models', mode: 'inline', maxQueue: 1 });
    const first = stt.transcribe(audio(), options(controller.signal)).catch((e: unknown) => e);
    const second = stt.transcribe(audio(), options());
    const third = await stt.transcribe(audio(), options()).catch((e: unknown) => e);
    expect((third as Error).name).toBe('TranscriptionUnavailableError');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    release();
    expect(((await first) as Error).name).toBe('AbortError');
    expect(await second).toEqual({ text: 'hallo' });
  });

  it('ignores the language option', async () => {
    const { deps: d, engine } = deps();
    const stt = createLocalTranscriberWith(d, { modelDir: '/models', mode: 'inline' });
    const samples = new Float32Array(8).fill(0.3);
    await stt.transcribe({ samples, sampleRate: 16000 }, { language: 'de', signal: new AbortController().signal });
    await stt.transcribe({ samples, sampleRate: 16000 }, { language: 'en', signal: new AbortController().signal });
    expect(engine.transcribe.mock.calls[0]![0]).toBe(samples);
    expect(engine.transcribe.mock.calls[1]![0]).toBe(samples);
    expect(engine.transcribe.mock.calls[0]!.length).toBe(engine.transcribe.mock.calls[1]!.length);
  });
});

describe('checkLocalStt', () => {
  it('probes, restarts and probes again without loading a model', async () => {
    const { deps: d, workers } = deps({ platform: () => ({ platform: 'linux', arch: 'arm64', glibcVersionRuntime: '2.36' }) });
    const check = checkLocalSttWith(d, {});
    for (let i = 0; i < 2; i += 1) {
      for (let t = 0; t < 5 && !workers[i]?.posted.length; t += 1) await tick();
      expect(workers[i]!.posted).toEqual([{ type: 'probe' }]);
      workers[i]!.reply({ type: 'probed', sherpaVersion: '2.0.1' });
      await tick();
    }
    expect(await check).toEqual({ platform: 'linux', arch: 'arm64', glibc: '2.36', sherpaVersion: '2.0.1', workerRestarts: 1 });
    expect(d.spawn).toHaveBeenCalledTimes(2);
    expect(d.loadSherpa).toHaveBeenCalledOnce();
    expect(workers[0]!.terminated).toBe(1);
    expect(workers.flatMap((w) => w.posted).some((m) => m.type === 'load')).toBe(false);
  });

  it('rejects platform_unsupported on musl before any import or spawn', async () => {
    const { deps: d } = deps({ platform: () => musl });
    await expect(checkLocalSttWith(d, {})).rejects.toMatchObject({ code: 'platform_unsupported' });
    expect(d.loadSherpa).not.toHaveBeenCalled();
    expect(d.spawn).not.toHaveBeenCalled();
  });
});
