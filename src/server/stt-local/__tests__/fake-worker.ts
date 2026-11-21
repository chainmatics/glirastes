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

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message as PostedMessage);
    this.transfers.push(transfer ?? []);
  }

  terminate(): Promise<number> {
    this.terminated += 1;
    queueMicrotask(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }

  reply(message: object): void {
    this.emit('message', message);
  }

  jobs(): PostedMessage[] {
    return this.posted.filter((m) => m.type === 'job');
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
