import { describe, expect, it } from 'vitest';
import {
  CheckpointConflictError,
  assertRuntimePersistenceReady,
  createPostgresRuntimeStore,
  type PostgresQueryClient,
} from '../postgres-store.js';

interface ScriptedResult {
  operation: string;
  rows: Record<string, unknown>[];
}

class ScriptedClient implements PostgresQueryClient {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];

  constructor(private readonly results: ScriptedResult[] = []) {}

  async unsafe<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T[]> {
    this.calls.push({ sql, parameters });
    const operation = /glirastes:([a-z-]+)/.exec(sql)?.[1];
    const resultIndex = this.results.findIndex(
      (candidate) => candidate.operation === operation,
    );
    if (resultIndex === -1) {
      return [];
    }
    const [result] = this.results.splice(resultIndex, 1);
    return result.rows as T[];
  }
}

const scope = {
  environmentId: 'env-1',
  tenantId: 'tenant-1',
  subjectId: 'user-1',
};

describe('PostgresRuntimeStore conversations', () => {
  it('initializes local tables without requiring a platform connection', async () => {
    const client = new ScriptedClient();
    const store = createPostgresRuntimeStore(client);

    await store.initialize();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('glirastes_runtime_conversations');
    expect(client.calls[0]?.sql).toContain('glirastes_runtime_checkpoints');
    expect(client.calls[0]?.sql).toContain('glirastes_runtime_tool_executions');
  });

  it('stores visibility, ownership, and retention locally', async () => {
    const client = new ScriptedClient([{
      operation: 'save-conversation',
      rows: [{ conversation_id: 'conversation-1' }],
    }]);
    const store = createPostgresRuntimeStore(client);

    await store.saveConversation({
      ...scope,
      conversationId: 'conversation-1',
      visibility: 'private',
      messages: [{ role: 'user', content: 'hello' }],
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const call = client.calls[0];
    expect(call?.sql).toContain('glirastes:save-conversation');
    expect(call?.parameters).toContain('private');
    expect(call?.parameters).toContain('user-1');
    expect(call?.parameters).toContain('tenant-1');
    expect(call?.parameters).toContain('2026-08-01T00:00:00.000Z');
  });

  it('loads only conversations visible to the verified tenant and subject', async () => {
    const client = new ScriptedClient([{
      operation: 'load-conversation',
      rows: [{
        conversation_id: 'conversation-1',
        tenant_id: 'tenant-1',
        owner_subject_id: 'user-1',
        visibility: 'private',
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
        ],
        updated_at: '2026-07-29T09:00:00.000Z',
        expires_at: null,
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    const conversation = await store.loadConversation({
      ...scope,
      conversationId: 'conversation-1',
    });

    expect(conversation?.messages).toHaveLength(2);
    expect(client.calls[0]?.sql).toContain("visibility = 'tenant'");
    expect(client.calls[0]?.sql).toContain('owner_subject_id = $4');
    expect(client.calls[0]?.parameters).toEqual([
      'env-1',
      'conversation-1',
      'tenant-1',
      'user-1',
    ]);
  });

  it('projects a bounded tail without mutating persisted history', async () => {
    const client = new ScriptedClient([{
      operation: 'load-conversation',
      rows: [{
        conversation_id: 'conversation-1',
        tenant_id: 'tenant-1',
        owner_subject_id: 'user-1',
        visibility: 'tenant',
        messages: [
          { role: 'user', content: 'discard me' },
          { role: 'assistant', content: 'keep two' },
          { role: 'user', content: 'keep three' },
        ],
        updated_at: '2026-07-29T09:00:00.000Z',
        expires_at: null,
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    const projected = await store.projectConversation({
      ...scope,
      conversationId: 'conversation-1',
      maxMessages: 2,
      maxCharacters: 100,
    });

    expect(projected).toEqual([
      { role: 'assistant', content: 'keep two' },
      { role: 'user', content: 'keep three' },
    ]);
  });

  it('purges expired local conversations', async () => {
    const client = new ScriptedClient([{
      operation: 'purge-conversations',
      rows: [{ deleted_count: 3 }],
    }]);
    const store = createPostgresRuntimeStore(client);

    await expect(
      store.purgeExpiredConversations(new Date('2026-07-29T10:00:00.000Z')),
    ).resolves.toBe(3);
  });
});

describe('PostgresRuntimeStore checkpoints and tool evidence', () => {
  it('saves a checkpoint only at the expected run sequence', async () => {
    const client = new ScriptedClient([{
      operation: 'save-checkpoint',
      rows: [{
        checkpoint_id: 'checkpoint-1',
        sequence: 2,
        created_at: '2026-07-29T09:00:00.000Z',
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    const saved = await store.saveCheckpoint({
      environmentId: 'env-1',
      runId: 'run-1',
      turnId: 'turn-1',
      agentRevisionId: 'agent-revision-1',
      expectedSequence: 1,
      status: 'paused',
      state: { node: 'approval' },
    });

    expect(saved.sequence).toBe(2);
    expect(client.calls[0]?.parameters).toContain(1);
    expect(client.calls[0]?.sql).toContain('pg_advisory_xact_lock');
  });

  it('rejects a stale checkpoint writer', async () => {
    const store = createPostgresRuntimeStore(new ScriptedClient());

    await expect(store.saveCheckpoint({
      environmentId: 'env-1',
      runId: 'run-1',
      turnId: 'turn-1',
      agentRevisionId: 'agent-revision-1',
      expectedSequence: 4,
      status: 'running',
      state: {},
    })).rejects.toBeInstanceOf(CheckpointConflictError);
  });

  it('loads the latest durable checkpoint for resume', async () => {
    const client = new ScriptedClient([{
      operation: 'load-checkpoint',
      rows: [{
        checkpoint_id: 'checkpoint-2',
        run_id: 'run-1',
        turn_id: 'turn-1',
        agent_revision_id: 'agent-revision-1',
        sequence: 2,
        status: 'paused',
        state: { node: 'approval' },
        created_at: '2026-07-29T09:00:00.000Z',
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    const checkpoint = await store.loadLatestCheckpoint({
      environmentId: 'env-1',
      runId: 'run-1',
    });

    expect(checkpoint).toMatchObject({
      checkpointId: 'checkpoint-2',
      sequence: 2,
      state: { node: 'approval' },
    });
  });

  it('claims an idempotency key exactly once and returns prior evidence', async () => {
    const client = new ScriptedClient([
      {
        operation: 'claim-tool-execution',
        rows: [{
          idempotency_key: 'tool-call-1',
          tool_uuid: 'tool-1',
          input_fingerprint: 'input-hash',
          status: 'pending',
          result: null,
          result_fingerprint: null,
          claimed: true,
          created_at: '2026-07-29T09:00:00.000Z',
          completed_at: null,
        }],
      },
      {
        operation: 'claim-tool-execution',
        rows: [{
          idempotency_key: 'tool-call-1',
          tool_uuid: 'tool-1',
          input_fingerprint: 'input-hash',
          status: 'completed',
          result: { taskId: 'task-1' },
          result_fingerprint: 'result-hash',
          claimed: false,
          created_at: '2026-07-29T09:00:00.000Z',
          completed_at: '2026-07-29T09:00:01.000Z',
        }],
      },
    ]);
    const store = createPostgresRuntimeStore(client);
    const claim = {
      environmentId: 'env-1',
      runId: 'run-1',
      idempotencyKey: 'tool-call-1',
      toolUuid: 'tool-1',
      inputFingerprint: 'input-hash',
    };

    const first = await store.claimToolExecution(claim);
    const replay = await store.claimToolExecution(claim);

    expect(first.claimed).toBe(true);
    expect(replay).toMatchObject({
      claimed: false,
      status: 'completed',
      result: { taskId: 'task-1' },
    });
  });

  it('refuses reuse of an idempotency key for different input', async () => {
    const client = new ScriptedClient([{
      operation: 'claim-tool-execution',
      rows: [{
        idempotency_key: 'tool-call-1',
        tool_uuid: 'tool-1',
        input_fingerprint: 'different-input',
        status: 'completed',
        result: {},
        result_fingerprint: 'result-hash',
        claimed: false,
        created_at: '2026-07-29T09:00:00.000Z',
        completed_at: '2026-07-29T09:00:01.000Z',
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    await expect(store.claimToolExecution({
      environmentId: 'env-1',
      runId: 'run-1',
      idempotencyKey: 'tool-call-1',
      toolUuid: 'tool-1',
      inputFingerprint: 'input-hash',
    })).rejects.toThrow('different tool or input');
  });

  it('replays an already completed tool result without executing again', async () => {
    const client = new ScriptedClient([{
      operation: 'complete-tool-execution',
      rows: [{
        idempotency_key: 'tool-call-1',
        tool_uuid: 'tool-1',
        input_fingerprint: 'input-hash',
        status: 'completed',
        result: { taskId: 'task-1' },
        result_fingerprint: 'result-hash',
        claimed: false,
        created_at: '2026-07-29T09:00:00.000Z',
        completed_at: '2026-07-29T09:00:01.000Z',
      }],
    }]);
    const store = createPostgresRuntimeStore(client);

    const replay = await store.completeToolExecution({
      environmentId: 'env-1',
      runId: 'run-1',
      idempotencyKey: 'tool-call-1',
      toolUuid: 'tool-1',
      inputFingerprint: 'input-hash',
      status: 'completed',
      result: { taskId: 'task-1' },
      resultFingerprint: 'result-hash',
    });

    expect(replay).toMatchObject({
      claimed: false,
      status: 'completed',
      result: { taskId: 'task-1' },
    });
  });
});

describe('runtime persistence deployment gate', () => {
  it('keeps the zero-setup interactive path optional', () => {
    expect(() => assertRuntimePersistenceReady({
      executionMode: 'interactive',
      resumableAcrossRestarts: false,
    })).not.toThrow();
  });

  it.each(['asynchronous', 'scheduled', 'unattended'] as const)(
    'requires a durable store for %s execution',
    (executionMode) => {
      expect(() => assertRuntimePersistenceReady({
        executionMode,
        resumableAcrossRestarts: false,
      })).toThrow('durable RuntimeStore');
    },
  );

  it('requires a durable store for restart-resumable interactive runs', () => {
    expect(() => assertRuntimePersistenceReady({
      executionMode: 'interactive',
      resumableAcrossRestarts: true,
    })).toThrow('durable RuntimeStore');
  });
});
