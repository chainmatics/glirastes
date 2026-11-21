import { EventEmitter } from 'node:events';
import type { WorkerLike } from '../worker-host.js';

export interface PostedMessage {
  type: string;
  id?: number;
  samples?: Float32Array;
  cancel?: Int32Array;
  deadline?: number;
}

/** A scriptable stand-in for a node:worker_threads Worker. */
export class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: PostedMessage[] = [];
  readonly transfers: unknown[][] = [];
  terminated = 0;
  /** Thrown by the next job post (e.g. a DataCloneError), then cleared. */
  failNextJobPost: Error | undefined;
  /** When set, terminate() resolves (and the worker exits) only once this is called. */
  private releaseTerminate: (() => void) | undefined;
  holdTerminate = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if ((message as PostedMessage).type === 'job' && this.failNextJobPost) {
      const error = this.failNextJobPost;
      this.failNextJobPost = undefined;
      throw error;
    }
    // Clone with the transfer list like a real worker: transferred buffers are detached.
    this.posted.push(structuredClone(message, { transfer: transfer ?? [] }) as PostedMessage);
    this.transfers.push(transfer ?? []);
  }

  terminate(): Promise<number> {
    this.terminated += 1;
    if (!this.holdTerminate) {
      queueMicrotask(() => this.emit('exit', 1));
      return Promise.resolve(1);
    }
    return new Promise<number>((resolve) => {
      this.releaseTerminate = () => {
        this.emit('exit', 1);
        resolve(1);
      };
    });
  }

  /** Lets a held terminate() finish. */
  finishTerminate(): void {
    this.releaseTerminate?.();
  }

  reply(message: object): void {
    this.emit('message', message);
  }

  jobs(): PostedMessage[] {
    return this.posted.filter((m) => m.type === 'job');
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
