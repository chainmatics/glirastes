import { TranscriptionUnavailableError } from '../adapters/nextjs/recording-transcription-handler.js';
import { abortError } from './engine.js';
import { SttLocalError, type SttLocalErrorCode } from './errors.js';

/** The part of a node:worker_threads `Worker` the host uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  on(event: 'message' | 'error' | 'exit', listener: (value: any) => void): void;
  terminate(): Promise<number>;
}

export interface WorkerHostOptions {
  spawn: () => WorkerLike;
  /** Loads the native addon on the main thread; awaited once before the first spawn. */
  preload: () => Promise<void>;
  /** Jobs allowed to wait behind the running one; beyond that `run` rejects with `TranscriptionUnavailableError`. */
  maxQueue: number;
  /** How long a cancelled or overdue job may take to answer before the worker is terminated. */
  hardStopGraceMs: number;
}

type WorkerMessage =
  | { type: 'loaded' }
  | { type: 'probed'; sherpaVersion: string }
  | { type: 'done'; id: number; text: string }
  | { type: 'aborted'; id: number }
  | { type: 'error'; id?: number; code?: string; message?: string };

interface Job {
  id: number;
  samples: Float32Array;
  signal: AbortSignal;
  deadline: number;
  cancel: Int32Array;
  posted: boolean;
  settled: boolean;
  timers: ReturnType<typeof setTimeout>[];
  resolve(text: string): void;
  reject(error: unknown): void;
  onAbort(): void;
}

interface Control {
  expect: 'loaded' | 'probed';
  resolve(message: WorkerMessage): void;
  reject(error: unknown): void;
}

const CODES: readonly SttLocalErrorCode[] = ['peer_missing', 'platform_unsupported', 'models_missing', 'load_failed', 'worker_failed'];
const toCode = (code: unknown): SttLocalErrorCode => (CODES.includes(code as SttLocalErrorCode) ? code as SttLocalErrorCode : 'load_failed');

/**
 * Runs transcription jobs on one worker thread: preload on the main thread,
 * lazy spawn, single-flight model load, one job at a time with a bounded
 * queue, between-chunk cancellation through a SharedArrayBuffer flag, and
 * `terminate()` only as a hard stop for a job that does not answer in time.
 * A dead worker fails its running job and is replaced lazily.
 */
export class WorkerHost {
  private readonly options: WorkerHostOptions;
  private preloaded: Promise<void> | undefined;
  private worker: WorkerLike | undefined;
  private loading: Promise<void> | undefined;
  private controls: Control[] = [];
  private control: Promise<unknown> = Promise.resolve();
  private queue: Job[] = [];
  private running: Job | undefined;
  private nextId = 1;
  private exitReason: string | undefined;
  /** The discarded worker's terminate(); a new worker spawns only after it, so one model is resident at a time. */
  private terminating: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerHostOptions) {
    this.options = options;
  }

  /** Loads the model in the worker; concurrent callers share one load. */
  load(): Promise<void> {
    this.loading ??= this.request('load', 'loaded').then(
      () => undefined,
      (error: unknown) => {
        this.loading = undefined;
        void this.discardWorker();
        throw error;
      },
    );
    return this.loading;
  }

  /** Loads only the addon in the worker (no model) and returns the sherpa-onnx-node version. */
  async probe(): Promise<string> {
    const message = await this.request('probe', 'probed');
    return (message as { sherpaVersion: string }).sherpaVersion;
  }

  run(samples: Float32Array, signal: AbortSignal, deadline: number): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError());
    if ((this.running ? 1 : 0) + this.queue.length > this.options.maxQueue) {
      return Promise.reject(new TranscriptionUnavailableError('The local speech recognizer is busy'));
    }
    return new Promise<string>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        // A private copy: its buffer is transferred to the worker, the caller's array stays usable.
        samples: samples.slice(),
        signal,
        deadline,
        cancel: new Int32Array(new SharedArrayBuffer(4)),
        posted: false,
        settled: false,
        timers: [],
        resolve,
        reject,
        onAbort: () => this.cancel(job),
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
      if (Number.isFinite(deadline)) {
        job.timers.push(setTimeout(() => this.cancel(job), Math.max(0, deadline - Date.now())));
      }
      this.queue.push(job);
      this.next();
    });
  }

  /** Terminates the worker and rejects every pending job; a later call starts a fresh worker. */
  async close(): Promise<void> {
    const jobs = [...(this.running ? [this.running] : []), ...this.queue];
    this.queue = [];
    this.running = undefined;
    for (const job of jobs) this.settle(job, abortError());
    await this.discardWorker(new SttLocalError('worker_failed', 'The local speech worker was closed'));
  }

  private async ensureWorker(): Promise<WorkerLike> {
    if (!this.preloaded) {
      this.preloaded = this.options.preload().catch((error: unknown) => {
        this.preloaded = undefined;
        throw error;
      });
    }
    await this.preloaded;
    if (this.worker) return this.worker;
    await this.terminating;
    if (this.worker) return this.worker;
    const worker = this.options.spawn();
    this.worker = worker;
    this.exitReason = undefined;
    worker.on('message', (message: WorkerMessage) => {
      if (worker === this.worker) this.onMessage(message);
    });
    worker.on('error', (error: unknown) => {
      if (worker === this.worker) this.exitReason = error instanceof Error ? error.message : String(error);
    });
    worker.on('exit', (code: number) => {
      if (worker === this.worker) this.onExit(code);
    });
    return worker;
  }

  /** Serialized control requests (load, probe): the worker answers them without an id. */
  private request(type: 'load' | 'probe', expect: Control['expect']): Promise<WorkerMessage> {
    const next = this.control.then(async () => {
      const worker = await this.ensureWorker();
      return new Promise<WorkerMessage>((resolve, reject) => {
        this.controls.push({ expect, resolve, reject });
        worker.postMessage({ type });
      });
    });
    this.control = next.catch(() => undefined);
    return next;
  }

  private onMessage(message: WorkerMessage): void {
    if (message.type === 'loaded' || message.type === 'probed' || (message.type === 'error' && message.id === undefined)) {
      const control = this.controls.shift();
      if (!control) return;
      if (message.type === 'error') {
        control.reject(new SttLocalError(toCode(message.code), message.message ?? 'The local speech worker failed to load'));
      } else {
        control.resolve(message);
      }
      return;
    }
    const job = this.running;
    if (!job || message.id !== job.id) return;
    if (message.type === 'done') this.finish(job, message.text);
    else if (message.type === 'aborted') this.finish(job, abortError());
    else this.finish(job, new Error(message.message ?? 'Local transcription failed'));
  }

  private onExit(code: number): void {
    const reason = this.exitReason ? `: ${this.exitReason}` : '';
    const error = new SttLocalError('worker_failed', `The local speech worker exited unexpectedly (code ${code})${reason}`);
    this.worker = undefined;
    this.loading = undefined;
    for (const control of this.controls.splice(0)) control.reject(error);
    const job = this.running;
    if (job) this.finish(job, error);
  }

  /** Forgets the current worker (its events are ignored from now on) and terminates it. */
  private async discardWorker(error?: unknown): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.loading = undefined;
    const controls = this.controls.splice(0);
    if (error) for (const control of controls) control.reject(error);
    if (worker) {
      const terminated = worker.terminate().catch(() => undefined);
      this.terminating = Promise.all([this.terminating, terminated]);
      await terminated;
    }
  }

  private cancel(job: Job): void {
    if (job.settled) return;
    if (!job.posted) {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      if (this.running === job) this.running = undefined;
      this.settle(job, abortError());
      this.next();
      return;
    }
    if (Atomics.load(job.cancel, 0) === 1) return;
    Atomics.store(job.cancel, 0, 1);
    job.timers.push(setTimeout(() => {
      if (job.settled || this.running !== job) return;
      // Discard first, so the next job's spawn waits for this worker's terminate().
      void this.discardWorker();
      this.finish(job, abortError());
    }, this.options.hardStopGraceMs));
  }

  private settle(job: Job, result: string | Error): void {
    if (job.settled) return;
    job.settled = true;
    for (const timer of job.timers) clearTimeout(timer);
    job.signal.removeEventListener('abort', job.onAbort);
    if (typeof result === 'string') job.resolve(result);
    else job.reject(result);
  }

  /** Settles the running job and starts the next one. */
  private finish(job: Job, result: string | Error): void {
    this.settle(job, result);
    if (this.running === job) this.running = undefined;
    this.next();
  }

  /** Starts the next job; a pump never leaves an unhandled rejection behind. */
  private next(): void {
    this.pump().catch((error: unknown) => {
      const job = this.running;
      if (job) this.finish(job, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    this.running = job;
    try {
      await this.load();
    } catch (error) {
      if (this.running === job) this.finish(job, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (job.settled || this.running !== job || !this.worker) {
      if (this.running === job) {
        this.running = undefined;
        this.next();
      }
      return;
    }
    try {
      this.worker.postMessage(
        { type: 'job', id: job.id, samples: job.samples, cancel: job.cancel, deadline: job.deadline },
        [job.samples.buffer as ArrayBuffer],
      );
      job.posted = true;
    } catch (error) {
      // e.g. a DataCloneError: fail this job only, the worker never saw it.
      this.finish(job, error instanceof Error ? error : new Error(String(error)));
    }
  }
}
