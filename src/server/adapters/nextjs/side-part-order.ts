/**
 * Places the parts the handler writes from `streamText` callbacks at a fixed
 * position in the model's UI stream. Written next to the merged stream, they
 * would land wherever the scheduler puts them: the step callback runs after
 * the step's `finish-step` left the AI SDK, `onFinish` after `finish`, while
 * those chunks still travel through the stream's transforms.
 *
 * - A step report goes right before the `finish-step` of its step, after
 *   every chunk of the step (approval requests included).
 * - An end part (the final pipeline state) goes right before `finish` or
 *   `abort`, so the terminal part stays last.
 */
export interface SidePartOrder<T> {
  /** The parts of the step that just finished: once per step, in step order. */
  stepFinished(parts: readonly T[]): void;
  /** A part for the end of the turn; written directly once the stream has ended. */
  beforeEnd(part: T): void;
  /**
   * The model stream with the side parts in place. `settled` is awaited
   * before the end, so a part the turn writes when it settles still comes
   * before the terminal part.
   */
  sequence(stream: ReadableStream<T>, settled?: Promise<unknown>): ReadableStream<T>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function createSidePartOrder<T extends { type: string }>(write: (part: T) => void): SidePartOrder<T> {
  const steps: Array<Deferred<readonly T[]>> = [];
  let finishedSteps = 0;
  const endParts: T[] = [];
  let ended = false;
  let released = false;

  const step = (index: number) => {
    const entry = (steps[index] ??= deferred<readonly T[]>());
    if (released) entry.resolve([]);
    return entry;
  };
  // A settled turn calls no step callback any more: no finish-step may wait for one.
  const release = () => {
    released = true;
    for (const entry of steps) entry?.resolve([]);
  };

  return {
    stepFinished(parts) {
      step(finishedSteps++).resolve(parts);
    },
    beforeEnd(part) {
      if (ended) write(part);
      else endParts.push(part);
    },
    sequence(stream, settled) {
      const reader = stream.getReader();
      const terminals: T[] = [];
      let seenSteps = 0;
      settled?.then(release, release);
      return new ReadableStream<T>({
        async pull(controller) {
          // A pull that enqueues nothing is not repeated: read on until one does.
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              await settled?.then(() => {}, () => {});
              ended = true;
              for (const part of endParts.splice(0)) controller.enqueue(part);
              for (const part of terminals) controller.enqueue(part);
              controller.close();
              return;
            }
            if (value.type === 'finish' || value.type === 'abort') {
              terminals.push(value);
              continue;
            }
            if (value.type === 'finish-step') {
              for (const part of await step(seenSteps++).promise) controller.enqueue(part);
            }
            controller.enqueue(value);
            return;
          }
        },
        cancel(reason) {
          ended = true;
          return reader.cancel(reason);
        },
      });
    },
  };
}
