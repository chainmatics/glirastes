import { describe, it, expect } from 'vitest';
import { filterFallbackError } from '../filter-fallback-error.js';

const FALLBACK = 'No output generated. Check the stream for errors.';

function streamFrom<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
}

describe('filterFallbackError', () => {
  it('passes through a single error event', async () => {
    const chunks = await collect(
      filterFallbackError(streamFrom([{ type: 'error', errorText: FALLBACK }])),
    );
    expect(chunks).toEqual([{ type: 'error', errorText: FALLBACK }]);
  });

  it('drops the fallback error when a real error already streamed', async () => {
    const chunks = await collect(
      filterFallbackError(
        streamFrom([
          { type: 'text-delta', delta: 'hi', id: '1' },
          { type: 'error', errorText: 'Incorrect API key' },
          { type: 'data-pipeline-state', data: { status: 'error' } },
          { type: 'error', errorText: FALLBACK },
        ]),
      ),
    );
    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'hi', id: '1' },
      { type: 'error', errorText: 'Incorrect API key' },
      { type: 'data-pipeline-state', data: { status: 'error' } },
    ]);
  });

  it('keeps a non-fallback second error untouched', async () => {
    const chunks = await collect(
      filterFallbackError(
        streamFrom([
          { type: 'error', errorText: 'first thing went wrong' },
          { type: 'error', errorText: 'a different actual error' },
        ]),
      ),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual({ type: 'error', errorText: 'a different actual error' });
  });

  it('forwards non-error chunks unchanged', async () => {
    const chunks = await collect(
      filterFallbackError(
        streamFrom([
          { type: 'start', messageId: 'X' },
          { type: 'text-delta', delta: 'hello', id: '1' },
          { type: 'finish' },
        ]),
      ),
    );
    expect(chunks).toHaveLength(3);
  });
});
