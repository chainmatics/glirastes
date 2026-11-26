import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TechnicalRuntimeEventV2Schema,
  TechnicalRuntimeEventV3Schema,
  type RuntimeMetricEvent,
} from '../../../../contracts/index.js';
import {
  agentRevision, localLimits, manifestRevision, policyRevision, principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { ManagedLocalRuntimeConfig, ResolveTurnSnapshotContext } from '../types.js';
import { declinedApprovalsOf } from '../ui-outcomes.js';

const DEPLOYMENT_ID = '019fb900-0000-7000-8000-0000000000d1';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textStep = () => convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Done.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
] as never);

function sink() {
  const events: RuntimeMetricEvent[] = [];
  const value: RuntimeMetricsSink = {
    identity: {
      appId: '019fb900-0000-7000-8000-0000000000a1', environmentId: '019fb900-0000-7000-8000-0000000000e1',
      buildId: 'git:4f2c9e1', instanceId: 'web-1',
    },
    record: (event) => { events.push(event); },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink: value, events };
}

function runtime(extra: Partial<ManagedLocalRuntimeConfig> = {}) {
  const contexts: ResolveTurnSnapshotContext[] = [];
  const config: ManagedLocalRuntimeConfig = {
    resolvePrincipal: async () => principal,
    resolveTurnSnapshot: async (context) => {
      contexts.push(context);
      return createTurnSnapshot({
        turnId: context.turnId, agentRevision, manifestRevision, policyRevision, principal, localLimits,
      });
    },
    ...extra,
  };
  return { config, contexts };
}

function handler(managedRuntime: ManagedLocalRuntimeConfig, metrics: RuntimeMetricsSink) {
  return createAiChatHandler({
    tools: {
      list_tasks: defineTool({
        id: agentRevision.toolAllowlist[0]!, description: 'List tasks.',
        inputSchema: z.object({ query: z.string() }), execute: async () => ({ tasks: [] }),
      }),
    },
    model: new MockLanguageModelV3({ doStream: async () => ({ stream: textStep() }) as never }),
    systemPrompt: 'Assistant',
    managedRuntime,
    metrics,
  });
}

const user = (id: string, text = 'Show tasks') => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const post = (body: Record<string, unknown>) => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('rollout cohorts in createAiChatHandler', () => {
  it('passes the conversation id of the request and reports the selected cohort as metric v3', async () => {
    const { sink: metrics, events } = sink();
    const { config, contexts } = runtime({
      turnRollout: ({ turnId }) => (turnId ? { deploymentId: DEPLOYMENT_ID, cohort: 'canary' } : undefined),
    });
    await (await handler(config, metrics)(post({ id: 'chat-7', messages: [user('u1')] }))).text();

    expect(contexts[0]?.conversationId).toBe('chat-7');
    const finished = events.filter((event) => event.eventType === 'turn.finished');
    expect(finished).toHaveLength(1);
    expect(TechnicalRuntimeEventV3Schema.parse(finished[0])).toMatchObject({
      schemaVersion: 3, deploymentId: DEPLOYMENT_ID, cohort: 'canary', approvalsDeclined: 0,
    });
  });

  it('falls back to the first user message without a conversation id and stays v2 without a rollout', async () => {
    const { sink: metrics, events } = sink();
    const { config, contexts } = runtime();
    const messages = [user('first'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] }, user('second')];
    await (await handler(config, metrics)(post({ id: 42, messages }))).text();

    expect(contexts[0]?.conversationId).toBe('ai-first');
    expect(contexts[0]?.turnId).toBe('ai-second');
    expect(TechnicalRuntimeEventV2Schema.safeParse(events.find((event) => event.eventType === 'turn.finished')).success)
      .toBe(true);
  });

  it('ignores an oversized conversation id', async () => {
    const { sink: metrics } = sink();
    const { config, contexts } = runtime();
    await (await handler(config, metrics)(post({ id: 'x'.repeat(300), messages: [user('u1')] }))).text();
    expect(contexts[0]?.conversationId).toBe('ai-u1');
  });
});

describe('declinedApprovalsOf', () => {
  const answered = (approved: boolean, id: string) => ({
    type: 'tool-tasks_archive', toolCallId: id, state: 'approval-responded', input: {}, approval: { id, approved },
  });

  it('counts the declined approvals of the last step only', () => {
    const messages = [user('u1'), {
      id: 'a1', role: 'assistant', parts: [
        answered(false, 'old'),
        { type: 'step-start' },
        answered(false, 'c1'), answered(true, 'c2'), answered(false, 'c3'),
      ],
    }];
    expect(declinedApprovalsOf(messages)).toBe(2);
  });

  it('counts nothing for a new user message', () => {
    expect(declinedApprovalsOf([user('u1')])).toBe(0);
    expect(declinedApprovalsOf([])).toBe(0);
  });
});
