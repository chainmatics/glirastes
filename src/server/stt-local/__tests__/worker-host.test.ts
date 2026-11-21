import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttLocalError } from '../errors.js';
import { WorkerHost } from '../worker-host.js';
import { FakeWorker, tick } from './fake-worker.js';

function setup(options: { maxQueue?: number; hardStopGraceMs?: number } = {}) {
  const order: string[] = [];
  const workers: FakeWorker[] = [];
  const preload = vi.fn(async () => { order.push('preload'); });
  const spawn = vi.fn(() => {
    order.push('spawn');
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const host = new WorkerHost({ spawn, preload, maxQueue: options.maxQueue ?? 4, hardStopGraceMs: options.hardStopGraceMs ?? 5000 });
  return { host, order, workers, preload, spawn };
}

const samples = (n = 4) => new Float32Array(n).fill(0.25);
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

async function loaded(workers: FakeWorker[], index = 0) {
  await tick();
  await tick();
  const worker = workers[index]!;
  expect(worker.posted.at(-1)?.type).toBe('load');
  worker.reply({ type: 'loaded' });
  await tick();
}

describe('WorkerHost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preloads the addon on the main thread before the first worker starts', async () => {
    const { host, order, workers } = setup();
    const load = host.load();
    await loaded(workers);
    await load;
    expect(order).toEqual(['preload', 'spawn']);
  });

  it('loads once for concurrent first jobs', async () => {
    const { host, workers, spawn } = setup();
    const runs = [host.run(samples(), new AbortController().signal, Infinity), host.run(samples(), new AbortController().signal, Infinity), host.run(samples(), new AbortController().signal, Infinity)];
    const extraLoad = host.load();
    await tick();
    await tick();
    expect(spawn).toHaveBeenCalledOnce();
    expect(workers[0]!.posted.filter((m) => m.type === 'load')).toHaveLength(1);
    await loaded(workers);
    await extraLoad;
    for (let i = 0; i < 3; i += 1) {
      const job = workers[0]!.jobs()[i]!;
      workers[0]!.reply({ type: 'done', id: job.id, text: `t${i}` });
      await tick();
    }
    expect(await Promise.all(runs)).toEqual(['t0', 't1', 't2']);
  });

  it('runs jobs one at a time in order and transfers a copy of the samples', async () => {
    const { host, workers } = setup();
    const first = samples(3);
    // An absolute time in the future; a past deadline would cancel the queued job at once.
    const deadline = Date.now() + 60_000;
    const a = host.run(first, new AbortController().signal, Infinity);
    const b = host.run(samples(5), new AbortController().signal, deadline);
    await loaded(workers);
    const worker = workers[0]!;
    expect(worker.jobs()).toHaveLength(1);
    expect(Array.from(worker.jobs()[0]!.samples!)).toEqual([0.25, 0.25, 0.25]);
    // The transferred buffer is the host's copy; the caller's array stays usable.
    expect(worker.transfers.at(-1)).toHaveLength(1);
    expect(worker.transfers.at(-1)![0]).not.toBe(first.buffer);
    expect(first.length).toBe(3);
    expect(worker.jobs()[0]!.cancel).toBeInstanceOf(Int32Array);
    expect(worker.jobs()[0]!.cancel!.buffer).toBeInstanceOf(SharedArrayBuffer);
    worker.reply({ type: 'done', id: worker.jobs()[0]!.id, text: 'a' });
    await tick();
    expect(worker.jobs()).toHaveLength(2);
    expect(worker.jobs()[1]!.deadline).toBe(deadline);
    worker.reply({ type: 'done', id: worker.jobs()[1]!.id, text: 'b' });
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });

  it('accepts the same samples again after a failed and after a successful job', async () => {
    const { host, workers } = setup();
    const audio = samples(3);
    const failed = settle(host.run(audio, new AbortController().signal, Infinity));
    await loaded(workers);
    const worker = workers[0]!;
    worker.reply({ type: 'error', id: worker.jobs()[0]!.id, message: 'decode failed' });
    expect(((await failed) as { error: Error }).error.message).toBe('decode failed');

    const retry = host.run(audio, new AbortController().signal, Infinity);
    await tick();
    expect(Array.from(worker.jobs()[1]!.samples!)).toEqual([0.25, 0.25, 0.25]);
    worker.reply({ type: 'done', id: worker.jobs()[1]!.id, text: 'ok' });
    expect(await retry).toBe('ok');

    const again = host.run(audio, new AbortController().signal, Infinity);
    await tick();
    expect(worker.jobs()[2]!.samples).toHaveLength(3);
    worker.reply({ type: 'done', id: worker.jobs()[2]!.id, text: 'again' });
    expect(await again).toBe('again');
    expect(audio.length).toBe(3);
  });

  it('rejects only the job whose post throws and keeps the queue moving', async () => {
    const { host, workers } = setup();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const first = settle(host.run(samples(), new AbortController().signal, Infinity));
      const second = host.run(samples(), new AbortController().signal, Infinity);
      await tick();
      await tick();
      const worker = workers[0]!;
      const cloneError = Object.assign(new Error('Cannot transfer object of unsupported type'), { name: 'DataCloneError' });
      worker.failNextJobPost = cloneError;
      worker.reply({ type: 'loaded' });
      expect(((await first) as { error: Error }).error).toBe(cloneError);
      await tick();
      expect(worker.jobs()).toHaveLength(1);
      worker.reply({ type: 'done', id: worker.jobs()[0]!.id, text: 'second' });
      expect(await second).toBe('second');
      expect(worker.terminated).toBe(0);
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects with TranscriptionUnavailableError beyond maxQueue', async () => {
    const { host, workers } = setup({ maxQueue: 1 });
    const running = settle(host.run(samples(), new AbortController().signal, Infinity));
    const waiting = settle(host.run(samples(), new AbortController().signal, Infinity));
    const third = await settle(host.run(samples(), new AbortController().signal, Infinity));
    expect((third as { error: Error }).error.name).toBe('TranscriptionUnavailableError');
    await loaded(workers);
    workers[0]!.reply({ type: 'done', id: workers[0]!.jobs()[0]!.id, text: '1' });
    await tick();
    workers[0]!.reply({ type: 'done', id: workers[0]!.jobs()[1]!.id, text: '2' });
    expect(await running).toEqual({ value: '1' });
    expect(await waiting).toEqual({ value: '2' });
  });

  it('frees the queue slot of a waiting job whose request aborts', async () => {
    const { host, workers } = setup({ maxQueue: 1 });
    const running = host.run(samples(), new AbortController().signal, Infinity);
    const controller = new AbortController();
    const waiting = settle(host.run(samples(), controller.signal, Infinity));
    controller.abort();
    expect(((await waiting) as { error: Error }).error.name).toBe('AbortError');
    const next = host.run(samples(), new AbortController().signal, Infinity);
    await loaded(workers);
    workers[0]!.reply({ type: 'done', id: workers[0]!.jobs()[0]!.id, text: '1' });
    await tick();
    workers[0]!.reply({ type: 'done', id: workers[0]!.jobs()[1]!.id, text: '3' });
    expect(await running).toBe('1');
    expect(await next).toBe('3');
  });

  it('rejects an already aborted signal without queueing', async () => {
    const { host, spawn } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await settle(host.run(samples(), controller.signal, Infinity));
    expect((result as { error: Error }).error.name).toBe('AbortError');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels between chunks without terminating', async () => {
    const { host, workers } = setup();
    const controller = new AbortController();
    const first = settle(host.run(samples(), controller.signal, Infinity));
    const second = host.run(samples(), new AbortController().signal, Infinity);
    await loaded(workers);
    const worker = workers[0]!;
    const job = worker.jobs()[0]!;
    expect(Atomics.load(job.cancel!, 0)).toBe(0);
    controller.abort();
    expect(Atomics.load(job.cancel!, 0)).toBe(1);
    worker.reply({ type: 'aborted', id: job.id });
    expect(((await first) as { error: Error }).error.name).toBe('AbortError');
    await tick();
    expect(worker.terminated).toBe(0);
    expect(worker.jobs()).toHaveLength(2);
    worker.reply({ type: 'done', id: worker.jobs()[1]!.id, text: 'next' });
    expect(await second).toBe('next');
    expect(workers).toHaveLength(1);
  });

  it('hard-stops a job that ignores cancellation and respawns lazily', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, workers, preload, spawn } = setup();
    const controller = new AbortController();
    const first = settle(host.run(samples(), controller.signal, Infinity));
    await loaded(workers);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4999);
    expect(workers[0]!.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]!.terminated).toBe(1);
    expect(((await first) as { error: Error }).error.name).toBe('AbortError');
    await tick();
    expect(spawn).toHaveBeenCalledOnce();
    const next = host.run(samples(), new AbortController().signal, Infinity);
    await tick();
    expect(spawn).toHaveBeenCalledTimes(2);
    await loaded(workers, 1);
    workers[1]!.reply({ type: 'done', id: workers[1]!.jobs()[0]!.id, text: 'fresh' });
    expect(await next).toBe('fresh');
    expect(preload).toHaveBeenCalledOnce();
  });

  it('starts the next worker only after the hard-stopped one has terminated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, workers, spawn } = setup({ hardStopGraceMs: 100 });
    const controller = new AbortController();
    const first = settle(host.run(samples(), controller.signal, Infinity));
    const queued = host.run(samples(), new AbortController().signal, Infinity);
    await loaded(workers);
    const old = workers[0]!;
    old.holdTerminate = true; // the native chunk is still running
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(old.terminated).toBe(1);
    expect(((await first) as { error: Error }).error.name).toBe('AbortError');
    for (let i = 0; i < 5; i += 1) await tick();
    // One model resident at a time: no second worker while the first still exits.
    expect(spawn).toHaveBeenCalledOnce();
    old.finishTerminate();
    await tick();
    await tick();
    expect(spawn).toHaveBeenCalledTimes(2);
    await loaded(workers, 1);
    workers[1]!.reply({ type: 'done', id: workers[1]!.jobs()[0]!.id, text: 'after' });
    expect(await queued).toBe('after');
  });

  it('hard-stops an overdue job that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { host, workers } = setup({ hardStopGraceMs: 100 });
    const job = settle(host.run(samples(), new AbortController().signal, Date.now() + 1000));
    await loaded(workers);
    await vi.advanceTimersByTimeAsync(1099);
    expect(workers[0]!.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]!.terminated).toBe(1);
    expect(((await job) as { error: Error }).error.name).toBe('AbortError');
  });

  it('fails the running job and recovers after an unexpected exit', async () => {
    const { host, workers } = setup();
    const first = settle(host.run(samples(), new AbortController().signal, Infinity));
    const queued = host.run(samples(), new AbortController().signal, Infinity);
    await loaded(workers);
    workers[0]!.emit('error', new Error('native crash'));
    workers[0]!.emit('exit', 134);
    const error = ((await first) as { error: SttLocalError }).error;
    expect(error).toBeInstanceOf(SttLocalError);
    expect(error.code).toBe('worker_failed');
    await tick();
    expect(workers).toHaveLength(2);
    await loaded(workers, 1);
    workers[1]!.reply({ type: 'done', id: workers[1]!.jobs()[0]!.id, text: 'recovered' });
    expect(await queued).toBe('recovered');
  });

  it('surfaces load_failed from the worker and the next run tries a fresh worker', async () => {
    const { host, workers } = setup();
    const first = settle(host.run(samples(), new AbortController().signal, Infinity));
    await tick();
    workers[0]!.reply({ type: 'error', code: 'load_failed', message: 'bad model' });
    const error = ((await first) as { error: SttLocalError }).error;
    expect(error.code).toBe('load_failed');
    expect(error.message).toContain('bad model');
    await tick();
    expect(workers[0]!.terminated).toBe(1);
    const next = host.run(samples(), new AbortController().signal, Infinity);
    await loaded(workers, 1);
    workers[1]!.reply({ type: 'done', id: workers[1]!.jobs()[0]!.id, text: 'ok' });
    expect(await next).toBe('ok');
  });

  it('probes the addon without loading a model', async () => {
    const { host, workers } = setup();
    const probe = host.probe();
    await tick();
    expect(workers[0]!.posted).toEqual([{ type: 'probe' }]);
    workers[0]!.reply({ type: 'probed', sherpaVersion: '2.0.1' });
    expect(await probe).toBe('2.0.1');
  });

  it('close terminates the worker, rejects pending jobs and allows a fresh start', async () => {
    const { host, workers } = setup();
    const running = settle(host.run(samples(), new AbortController().signal, Infinity));
    const queued = settle(host.run(samples(), new AbortController().signal, Infinity));
    await loaded(workers);
    await host.close();
    expect(workers[0]!.terminated).toBe(1);
    expect(((await running) as { error: Error }).error.name).toBe('AbortError');
    expect(((await queued) as { error: Error }).error.name).toBe('AbortError');
    const probe = host.probe();
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: 'probed', sherpaVersion: '2.0.1' });
    expect(await probe).toBe('2.0.1');
  });
});
