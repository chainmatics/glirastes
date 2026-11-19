import { describe, expect, it } from 'vitest';
import { createSidePartOrder } from '../side-part-order.js';

type Part = { type: string; id?: string };

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** A source whose chunks arrive with a delay, while `script` runs beside it. */
function source(script: (controller: ReadableStreamDefaultController<Part>) => Promise<void>): ReadableStream<Part> {
  return new ReadableStream<Part>({
    async start(controller) {
      await script(controller);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Part>): Promise<string[]> {
  const out: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value.id ? `${value.type}:${value.id}` : value.type);
  }
}

describe('side parts in the model stream', () => {
  it('puts a step report right before its finish-step when the step callback runs after finish-step went by', async () => {
    const order = createSidePartOrder<Part>(() => {});
    const stream = order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'tool-input-available' });
      controller.enqueue({ type: 'tool-approval-request' });
      controller.enqueue({ type: 'finish-step' });
      await later();
      order.stepFinished([{ type: 'data-step-report' }]);
      controller.enqueue({ type: 'finish' });
    }));
    expect(await collect(stream)).toEqual(['start-step', 'tool-input-available', 'tool-approval-request', 'data-step-report', 'finish-step', 'finish']);
  });

  it('never lets a step report overtake the chunks of its step', async () => {
    const order = createSidePartOrder<Part>(() => {});
    const stream = order.sequence(source(async (controller) => {
      order.stepFinished([{ type: 'data-step-report' }]);
      controller.enqueue({ type: 'start-step' });
      await later();
      controller.enqueue({ type: 'tool-input-available' });
      await later();
      controller.enqueue({ type: 'finish-step' });
      controller.enqueue({ type: 'finish' });
    }));
    expect(await collect(stream)).toEqual(['start-step', 'tool-input-available', 'data-step-report', 'finish-step', 'finish']);
  });

  it('matches the reports of several steps to their own finish-step', async () => {
    const order = createSidePartOrder<Part>(() => {});
    const stream = order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'finish-step' });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'finish-step' });
      await later();
      order.stepFinished([{ type: 'data-step-report', id: '0' }]);
      await later();
      order.stepFinished([{ type: 'data-step-report', id: '1' }]);
      controller.enqueue({ type: 'finish' });
    }));
    expect(await collect(stream)).toEqual(['data-step-report:0', 'finish-step', 'start-step', 'data-step-report:1', 'finish-step', 'finish']);
  });

  it('writes the end part before finish, also when it is known only after finish went by', async () => {
    const order = createSidePartOrder<Part>(() => {});
    const stream = order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'start' });
      controller.enqueue({ type: 'finish' });
      await later();
      order.beforeEnd({ type: 'data-pipeline-state' });
    }));
    expect(await collect(stream)).toEqual(['start', 'data-pipeline-state', 'finish']);
  });

  it('writes the end part before abort', async () => {
    const order = createSidePartOrder<Part>(() => {});
    const stream = order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'start' });
      order.beforeEnd({ type: 'data-pipeline-state' });
      controller.enqueue({ type: 'abort' });
    }));
    expect(await collect(stream)).toEqual(['start', 'data-pipeline-state', 'abort']);
  });

  it('waits for the turn to settle before it ends the stream', async () => {
    const order = createSidePartOrder<Part>(() => {});
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const stream = order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'finish' });
    }), settled);
    const collected = collect(stream);
    await later();
    order.beforeEnd({ type: 'data-pipeline-state' });
    settle();
    expect(await collected).toEqual(['data-pipeline-state', 'finish']);
  });

  it('writes an end part directly once the stream has ended', async () => {
    const written: Part[] = [];
    const order = createSidePartOrder<Part>((part) => written.push(part));
    expect(await collect(order.sequence(source(async (controller) => {
      controller.enqueue({ type: 'finish' });
    })))).toEqual(['finish']);
    order.beforeEnd({ type: 'data-pipeline-state' });
    expect(written).toEqual([{ type: 'data-pipeline-state' }]);
  });
});
