import { describe, expect, it } from 'vitest';
import type {
  RuntimeEngine,
  RuntimeEngineEvent,
  RuntimeRunRequest,
} from '../engine.js';

describe('RuntimeEngine contract', () => {
  it('supports an engine-neutral event stream', async () => {
    const events: RuntimeEngineEvent[] = [{
      type: 'run.started',
      runId: 'run-1',
      turnId: 'turn-1',
      occurredAt: '2026-07-28T20:00:00.000Z',
    }, {
      type: 'run.completed',
      runId: 'run-1',
      turnId: 'turn-1',
      occurredAt: '2026-07-28T20:00:01.000Z',
      status: 'completed',
    }];
    const engine: RuntimeEngine = {
      async *run(_request: RuntimeRunRequest) {
        yield* events;
      },
    };

    const received: RuntimeEngineEvent[] = [];
    for await (const event of engine.run({
      runId: 'run-1',
      turnId: 'turn-1',
      messages: [],
      tools: {},
    })) {
      received.push(event);
    }

    expect(received).toEqual(events);
  });
});
