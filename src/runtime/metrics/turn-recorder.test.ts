import { describe, expect, it, vi } from 'vitest';
import {
  TechnicalRuntimeEventV2Schema,
  type TechnicalRuntimeEventV2,
} from '../../contracts/index.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../turn-snapshot.js';
import { UNKNOWN_TURN_COST } from './cost.js';
import {
  createTurnMetricsRecorder,
  type RuntimeMetricsSink,
} from './turn-recorder.js';

const APP_ID = '019fb900-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '019fb900-0000-7000-8000-0000000000e1';
const SECRET = 'a'.repeat(32);
const LIST_TASKS_ID = agentRevision.toolAllowlist[0]!;
const provider = (usd: number) => ({
  usd,
  source: 'provider-reported' as const,
  pricingVersion: null,
});

function fakeSink(record: (event: TechnicalRuntimeEventV2) => void = () => undefined) {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
    },
    record: vi.fn((event: TechnicalRuntimeEventV2) => {
      events.push(event);
      record(event);
    }),
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

const snapshot = createTurnSnapshot({
  turnId: 'ai-message-1',
  agentRevision,
  manifestRevision,
  policyRevision,
  principal,
  localLimits,
});

describe('createTurnMetricsRecorder', () => {
  it('records one valid, content-free event per turn', () => {
    const { sink, events } = fakeSink();
    const time = clock();
    const recorder = createTurnMetricsRecorder({
      sink,
      snapshot,
      startedAtMs: time.now(),
      now: time.now,
      createEventId: () => '019fb900-0000-7000-8000-000000000001',
    });

    time.advance(400);
    recorder.markFirstChunk();
    time.advance(100);
    recorder.markFirstChunk();
    recorder.recordStep({
      model: 'anthropic/claude-sonnet-5.5',
      inputTokens: 900,
      outputTokens: 40,
      cost: provider(0.003),
      toolNames: ['list_tasks', 'find_tools', 'list_tasks'],
      failedToolNames: ['list_tasks'],
    });
    time.advance(1_300);
    recorder.recordStep({
      model: 'anthropic/claude-sonnet-5.5',
      inputTokens: 300,
      outputTokens: 200,
      cost: provider(0.0018),
      toolNames: [],
      failedToolNames: [],
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });

    expect(events).toEqual([event]);
    expect(TechnicalRuntimeEventV2Schema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      schemaVersion: 2,
      eventId: '019fb900-0000-7000-8000-000000000001',
      eventType: 'turn.finished',
      occurredAt: new Date(2_800).toISOString(),
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      model: 'anthropic/claude-sonnet-5.5',
      status: 'completed',
      errorCode: null,
      inputTokens: 1_200,
      outputTokens: 240,
      latency: { firstTokenMs: 400, totalMs: 1_800 },
      toolCallCount: 3,
      toolErrorCount: 1,
      tools: [{ toolId: LIST_TASKS_ID, calls: 2, errors: 1 }],
    });
    expect(event?.cost.source).toBe('provider-reported');
    expect(event?.cost.usd).toBeCloseTo(0.0048, 10);
    expect(JSON.stringify(event)).not.toContain('list_tasks');
    expect(JSON.stringify(event)).not.toContain('find_tools');
  });

  it('records a turn only once', () => {
    const { sink, events } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, snapshot, startedAtMs: Date.now() });

    expect(recorder.finish({ status: 'aborted', errorCode: null })).toBeDefined();
    expect(recorder.finish({ status: 'error', errorCode: 'model_error' })).toBeUndefined();
    expect(events.map((event) => event.status)).toEqual(['aborted']);
  });

  it('keeps an unknown step cost unknown for the whole turn', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: 'openai/gpt-6.1-sol',
      inputTokens: 10,
      outputTokens: 5,
      cost: provider(0.001),
      toolNames: [],
      failedToolNames: [],
    });
    recorder.recordStep({
      model: 'openai/gpt-6.1-sol',
      inputTokens: 10,
      outputTokens: 5,
      cost: UNKNOWN_TURN_COST,
      toolNames: [],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })?.cost)
      .toEqual(UNKNOWN_TURN_COST);
  });

  it('counts tools without a pinned snapshot but lists none and names no revision', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: ['list_tasks'],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })).toMatchObject({
      revisionId: null,
      model: null,
      toolCallCount: 1,
      tools: [],
      latency: { firstTokenMs: null },
    });
  });

  it('drops a model id that is not a technical label instead of the event', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });
    recorder.recordStep({
      model: 'show me all my tasks',
      inputTokens: 1,
      outputTokens: 1,
      cost: UNKNOWN_TURN_COST,
      toolNames: [],
      failedToolNames: [],
    });

    expect(recorder.finish({ status: 'completed', errorCode: null })?.model).toBeNull();
  });

  it('lists the 32 most used tools and still counts every call', () => {
    const tools = Array.from({ length: 40 }, (_, index) => ({
      ...manifestRevision.tools[0]!,
      toolId: `019fb900-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      name: `tool_${index}`,
    }));
    const wide = createTurnSnapshot({
      turnId: 'ai-wide',
      agentRevision,
      manifestRevision: { ...manifestRevision, tools },
      policyRevision,
      principal,
      localLimits,
    });
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, snapshot: wide, startedAtMs: Date.now() });
    recorder.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: [...tools.map((tool) => tool.name), 'tool_39'],
      failedToolNames: [],
    });

    const event = recorder.finish({ status: 'completed', errorCode: null });
    expect(event?.toolCallCount).toBe(41);
    expect(event?.tools).toHaveLength(32);
    expect(event?.tools).toContainEqual({ toolId: tools[39]!.toolId, calls: 2, errors: 0 });
    expect(event?.tools.map((tool) => tool.toolId))
      .toEqual([...(event?.tools.map((tool) => tool.toolId) ?? [])].sort());
  });

  it('never lets a failing sink reach the turn', () => {
    const { sink } = fakeSink(() => {
      throw new Error('sink down');
    });
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: Date.now() });

    expect(() => recorder.finish({ status: 'error', errorCode: 'pipeline_error' }))
      .not.toThrow();
    expect(sink.record).toHaveBeenCalledTimes(1);
  });
});

describe('tool_contract_rejected in the turn recorder', () => {
  it('hands a content-free rejection of a snapshot tool to the sink right away', () => {
    const records: unknown[] = [];
    const { sink } = fakeSink();
    sink.record = (event) => { records.push(event); };
    const recorder = createTurnMetricsRecorder({
      sink, snapshot, startedAtMs: 1_000, now: () => 2_000, createEventId: () => '019fb900-0000-7000-8000-000000000201',
    });
    const event = recorder.recordToolContractRejected('list_tasks', 400);
    expect(event).toEqual({
      schemaVersion: 2,
      eventId: '019fb900-0000-7000-8000-000000000201',
      eventType: 'tool_contract_rejected',
      occurredAt: '1970-01-01T00:00:02.000Z',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
      revisionId: agentRevision.revisionId,
      toolId: LIST_TASKS_ID,
      inputSchemaDigest: manifestRevision.tools[0]!.inputSchemaDigest,
      httpStatus: 400,
    });
    expect(records).toEqual([event]);
  });

  it('ignores tools outside the pinned snapshot and survives a failing sink', () => {
    const { sink } = fakeSink();
    sink.record = () => { throw new Error('sink down'); };
    const recorder = createTurnMetricsRecorder({ sink, snapshot, startedAtMs: 1_000 });
    expect(recorder.recordToolContractRejected('unknown_tool', 422)).toBeUndefined();
    expect(recorder.recordToolContractRejected('list_tasks', 422)).toMatchObject({ httpStatus: 422 });
    expect(createTurnMetricsRecorder({ sink, startedAtMs: 1_000 }).recordToolContractRejected('list_tasks', 400)).toBeUndefined();
  });

  it('finds a dotted manifest tool under its definitionId and under its model-facing name', () => {
    const dotted = createTurnSnapshot({
      turnId: 'ai-dotted',
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: [{ ...manifestRevision.tools[0]!, name: 'tasks.list' }],
      },
      policyRevision,
      principal,
      localLimits,
    });
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, snapshot: dotted, startedAtMs: 1_000 });
    for (const toolName of ['tasks.list', 'tasks_list']) {
      expect(recorder.recordToolContractRejected(toolName, 422)).toMatchObject({
        eventType: 'tool_contract_rejected',
        toolId: LIST_TASKS_ID,
        inputSchemaDigest: manifestRevision.tools[0]!.inputSchemaDigest,
        httpStatus: 422,
      });
    }
    expect(recorder.recordToolContractRejected('tasks.other', 422)).toBeUndefined();
    expect(sink.record).toHaveBeenCalledTimes(2);
  });
});

describe('a request that continues a turn', () => {
  it.each(['approval', 'ui-outcome'] as const)('reports %s as turn.continued instead of turn.finished', (continuation) => {
    const { sink, events } = fakeSink();
    const recorder = createTurnMetricsRecorder({
      sink, snapshot, startedAtMs: 0, now: () => 10, continuation, continuedTurn: { turnId: 'ai-message-1', secret: SECRET },
    });
    recorder.recordStep({
      model: 'anthropic/claude-sonnet-5.5', inputTokens: 5, outputTokens: 2, cost: UNKNOWN_TURN_COST,
      toolNames: [], failedToolNames: [],
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });
    expect(events).toEqual([event]);
    expect(event).toMatchObject({ eventType: 'turn.continued', continuation, inputTokens: 5, outputTokens: 2 });
    expect(event).toHaveProperty('turnId', expect.stringMatching(/^[0-9a-f]{32}$/));
  });

  const continuedTurnId = (
    turnId: string,
    options: { secret?: string; instanceId?: string; environmentId?: string; continuation?: 'approval' | 'ui-outcome' } = {},
  ) => {
    const { sink } = fakeSink();
    const identity = {
      ...sink.identity,
      instanceId: options.instanceId ?? sink.identity.instanceId,
      environmentId: options.environmentId ?? sink.identity.environmentId,
    };
    const recorder = createTurnMetricsRecorder({
      sink: { ...sink, identity },
      startedAtMs: 0,
      now: () => 10,
      continuation: options.continuation ?? 'ui-outcome',
      continuedTurn: { turnId, secret: options.secret ?? SECRET },
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });
    return event && 'turnId' in event ? event.turnId : undefined;
  };

  it('gives every continuation of one turn the same turn id, on any instance and after a restart', () => {
    const first = continuedTurnId('ai-message-1');
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(continuedTurnId('ai-message-1', { instanceId: 'web-2' })).toBe(first);
    expect(continuedTurnId('ai-message-1', { continuation: 'approval' })).toBe(first);
  });

  it('gives another turn, another key or another environment another turn id', () => {
    const first = continuedTurnId('ai-message-1');
    expect(continuedTurnId('ai-message-2')).not.toBe(first);
    expect(continuedTurnId('ai-message-1', { secret: 'b'.repeat(32) })).not.toBe(first);
    expect(continuedTurnId('ai-message-1', { environmentId: '019fb900-0000-7000-8000-0000000000e2' })).not.toBe(first);
  });

  it.each([
    ['long text', `ai-${'Please transfer 10,000 EUR to the account of my landlord. '.repeat(200)}`],
    ['PII', 'ai-max.mustermann@example.com +49 170 1234567 DE89370400440532013000'],
    ['unicode', 'ai-Grüße 🙂 日本語 \u202e\u0000'],
    ['a credential', 'ai-Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('never sends a client turn id with %s, only its opaque derivation', (_name, turnId) => {
    const { sink, events } = fakeSink();
    const recorder = createTurnMetricsRecorder({
      sink, startedAtMs: 0, now: () => 10, continuation: 'approval', continuedTurn: { turnId, secret: SECRET },
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });
    expect(event).toHaveProperty('turnId', expect.stringMatching(/^[0-9a-f]{32}$/));
    const sent = JSON.stringify(events);
    for (const piece of [turnId, turnId.slice(3), 'mustermann', 'landlord', 'Grüße', '日本語', 'Bearer']) {
      expect(sent).not.toContain(piece);
    }
  });

  it('builds no event for a continuation without its turn or with an empty key (fail closed)', () => {
    const { sink, events } = fakeSink();
    const recorder = createTurnMetricsRecorder({ sink, startedAtMs: 0, now: () => 10, continuation: 'ui-outcome' });
    expect(recorder.finish({ status: 'completed', errorCode: null })).toBeUndefined();
    expect(continuedTurnId('ai-message-1', { secret: '' })).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('keeps turn.finished without a turn id', () => {
    const { sink } = fakeSink();
    const recorder = createTurnMetricsRecorder({
      sink, startedAtMs: 0, now: () => 10, continuedTurn: { turnId: 'ai-message-1', secret: SECRET },
    });
    const event = recorder.finish({ status: 'completed', errorCode: null });
    expect(event?.eventType).toBe('turn.finished');
    expect(event).not.toHaveProperty('turnId');
  });
});
