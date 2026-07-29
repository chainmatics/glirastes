export interface PostgresQueryClient {
  unsafe<T extends Record<string, unknown>>(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<T[]>;
}

export type ConversationVisibility = 'private' | 'tenant';

export interface RuntimeStoreScope {
  environmentId: string;
  tenantId: string;
  subjectId: string;
}

export interface SaveConversationInput extends RuntimeStoreScope {
  conversationId: string;
  visibility: ConversationVisibility;
  messages: unknown[];
  expiresAt?: Date | null;
}

export interface LoadConversationInput extends RuntimeStoreScope {
  conversationId: string;
}

export interface ConversationRecord {
  conversationId: string;
  tenantId: string;
  ownerSubjectId: string;
  visibility: ConversationVisibility;
  messages: unknown[];
  updatedAt: Date;
  expiresAt: Date | null;
}

export interface ProjectConversationInput extends LoadConversationInput {
  maxMessages: number;
  maxCharacters: number;
}

export type RuntimeCheckpointStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SaveCheckpointInput {
  environmentId: string;
  runId: string;
  turnId: string;
  agentRevisionId: string;
  expectedSequence: number;
  status: RuntimeCheckpointStatus;
  state: unknown;
  checkpointId?: string;
}

export interface RuntimeCheckpoint {
  checkpointId: string;
  runId: string;
  turnId: string;
  agentRevisionId: string;
  sequence: number;
  status: RuntimeCheckpointStatus;
  state: unknown;
  createdAt: Date;
}

export interface ToolExecutionClaimInput {
  environmentId: string;
  runId: string;
  idempotencyKey: string;
  toolUuid: string;
  inputFingerprint: string;
}

export type ToolExecutionStatus = 'pending' | 'completed' | 'failed';

export interface ToolExecutionEvidence {
  claimed: boolean;
  idempotencyKey: string;
  toolUuid: string;
  inputFingerprint: string;
  status: ToolExecutionStatus;
  result: unknown | null;
  resultFingerprint: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompleteToolExecutionInput extends ToolExecutionClaimInput {
  status: Exclude<ToolExecutionStatus, 'pending'>;
  result: unknown;
  resultFingerprint: string;
}

export interface DurableRuntimeStore {
  saveCheckpoint(input: SaveCheckpointInput): Promise<RuntimeCheckpoint>;
  loadLatestCheckpoint(input: {
    environmentId: string;
    runId: string;
  }): Promise<RuntimeCheckpoint | null>;
  claimToolExecution(
    input: ToolExecutionClaimInput,
  ): Promise<ToolExecutionEvidence>;
  completeToolExecution(
    input: CompleteToolExecutionInput,
  ): Promise<ToolExecutionEvidence>;
}

export interface RuntimePersistenceRequirement {
  executionMode:
    | 'interactive'
    | 'asynchronous'
    | 'scheduled'
    | 'unattended';
  resumableAcrossRestarts: boolean;
  store?: DurableRuntimeStore;
}

export function assertRuntimePersistenceReady(
  requirement: RuntimePersistenceRequirement,
): void {
  const requiresDurableStore = requirement.executionMode !== 'interactive'
    || requirement.resumableAcrossRestarts;
  if (requiresDurableStore && !requirement.store) {
    throw new Error(
      `A durable RuntimeStore is required for ${requirement.executionMode} or restart-resumable execution.`,
    );
  }
}

export class CheckpointConflictError extends Error {
  constructor(runId: string, expectedSequence: number) {
    super(
      `Checkpoint sequence conflict for run "${runId}" at expected sequence ${expectedSequence}.`,
    );
    this.name = 'CheckpointConflictError';
  }
}

export const POSTGRES_RUNTIME_STORE_SCHEMA_SQL = `/* glirastes:initialize-store */
CREATE TABLE IF NOT EXISTS glirastes_runtime_conversations (
  environment_id text NOT NULL,
  conversation_id text NOT NULL,
  tenant_id text NOT NULL,
  owner_subject_id text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private', 'tenant')),
  messages jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (environment_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS glirastes_runtime_conversations_access_idx
  ON glirastes_runtime_conversations (environment_id, tenant_id, owner_subject_id);
CREATE INDEX IF NOT EXISTS glirastes_runtime_conversations_expiry_idx
  ON glirastes_runtime_conversations (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS glirastes_runtime_checkpoints (
  environment_id text NOT NULL,
  run_id text NOT NULL,
  checkpoint_id text NOT NULL,
  turn_id text NOT NULL,
  agent_revision_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (
    status IN ('running', 'paused', 'completed', 'failed', 'cancelled')
  ),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, run_id, sequence),
  UNIQUE (environment_id, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS glirastes_runtime_tool_executions (
  environment_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  tool_uuid text NOT NULL,
  input_fingerprint text NOT NULL,
  claim_token text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result jsonb,
  result_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (environment_id, run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS glirastes_runtime_tool_executions_tool_idx
  ON glirastes_runtime_tool_executions (environment_id, tool_uuid, created_at);
`;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asOptionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function mapConversation(row: Record<string, unknown>): ConversationRecord {
  const messages = parseJson(row.messages);
  return {
    conversationId: String(row.conversation_id),
    tenantId: String(row.tenant_id),
    ownerSubjectId: String(row.owner_subject_id),
    visibility: row.visibility as ConversationVisibility,
    messages: Array.isArray(messages) ? messages : [],
    updatedAt: asDate(row.updated_at),
    expiresAt: asOptionalDate(row.expires_at),
  };
}

function mapCheckpoint(row: Record<string, unknown>): RuntimeCheckpoint {
  return {
    checkpointId: String(row.checkpoint_id),
    runId: String(row.run_id),
    turnId: String(row.turn_id),
    agentRevisionId: String(row.agent_revision_id),
    sequence: Number(row.sequence),
    status: row.status as RuntimeCheckpointStatus,
    state: parseJson(row.state),
    createdAt: asDate(row.created_at),
  };
}

function mapToolEvidence(row: Record<string, unknown>): ToolExecutionEvidence {
  return {
    claimed: Boolean(row.claimed),
    idempotencyKey: String(row.idempotency_key),
    toolUuid: String(row.tool_uuid),
    inputFingerprint: String(row.input_fingerprint),
    status: row.status as ToolExecutionStatus,
    result: row.result === null ? null : parseJson(row.result),
    resultFingerprint:
      row.result_fingerprint === null ? null : String(row.result_fingerprint),
    createdAt: asDate(row.created_at),
    completedAt: asOptionalDate(row.completed_at),
  };
}

function projectTail(
  messages: unknown[],
  maxMessages: number,
  maxCharacters: number,
): unknown[] {
  if (!Number.isInteger(maxMessages) || maxMessages < 0) {
    throw new Error('maxMessages must be a non-negative integer.');
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 0) {
    throw new Error('maxCharacters must be a non-negative integer.');
  }

  const projected: unknown[] = [];
  let characters = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && projected.length < maxMessages;
    index -= 1
  ) {
    const message = messages[index];
    const size = JSON.stringify(message).length;
    if (characters + size > maxCharacters) {
      break;
    }
    projected.unshift(message);
    characters += size;
  }
  return projected;
}

export function createPostgresRuntimeStore(client: PostgresQueryClient) {
  async function loadConversation(
    input: LoadConversationInput,
  ): Promise<ConversationRecord | null> {
    const rows = await client.unsafe(
      `/* glirastes:load-conversation */
SELECT
  conversation_id,
  tenant_id,
  owner_subject_id,
  visibility,
  messages,
  updated_at,
  expires_at
FROM glirastes_runtime_conversations
WHERE environment_id = $1
  AND conversation_id = $2
  AND tenant_id = $3
  AND (visibility = 'tenant' OR owner_subject_id = $4)
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`,
      [
        input.environmentId,
        input.conversationId,
        input.tenantId,
        input.subjectId,
      ],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  return {
    async initialize(): Promise<void> {
      await client.unsafe(POSTGRES_RUNTIME_STORE_SCHEMA_SQL);
    },

    async saveConversation(input: SaveConversationInput): Promise<void> {
      const rows = await client.unsafe(
        `/* glirastes:save-conversation */
INSERT INTO glirastes_runtime_conversations (
  environment_id,
  conversation_id,
  tenant_id,
  owner_subject_id,
  visibility,
  messages,
  expires_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
ON CONFLICT (environment_id, conversation_id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  owner_subject_id = EXCLUDED.owner_subject_id,
  visibility = EXCLUDED.visibility,
  messages = EXCLUDED.messages,
  expires_at = EXCLUDED.expires_at,
  updated_at = now()
WHERE glirastes_runtime_conversations.tenant_id = EXCLUDED.tenant_id
  AND glirastes_runtime_conversations.owner_subject_id = EXCLUDED.owner_subject_id
RETURNING conversation_id`,
        [
          input.environmentId,
          input.conversationId,
          input.tenantId,
          input.subjectId,
          input.visibility,
          JSON.stringify(input.messages),
          input.expiresAt?.toISOString() ?? null,
        ],
      );
      if (!rows[0]) {
        throw new Error(
          `Conversation "${input.conversationId}" is owned by a different principal.`,
        );
      }
    },

    loadConversation,

    async projectConversation(
      input: ProjectConversationInput,
    ): Promise<unknown[]> {
      const conversation = await loadConversation(input);
      return conversation
        ? projectTail(
            conversation.messages,
            input.maxMessages,
            input.maxCharacters,
          )
        : [];
    },

    async deleteConversation(input: LoadConversationInput): Promise<boolean> {
      const rows = await client.unsafe(
        `/* glirastes:delete-conversation */
DELETE FROM glirastes_runtime_conversations
WHERE environment_id = $1
  AND conversation_id = $2
  AND tenant_id = $3
  AND owner_subject_id = $4
RETURNING conversation_id`,
        [
          input.environmentId,
          input.conversationId,
          input.tenantId,
          input.subjectId,
        ],
      );
      return rows.length > 0;
    },

    async purgeExpiredConversations(now = new Date()): Promise<number> {
      const rows = await client.unsafe(
        `/* glirastes:purge-conversations */
WITH deleted AS (
  DELETE FROM glirastes_runtime_conversations
  WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
  RETURNING 1
)
SELECT count(*)::integer AS deleted_count FROM deleted`,
        [now.toISOString()],
      );
      return Number(rows[0]?.deleted_count ?? 0);
    },

    async saveCheckpoint(
      input: SaveCheckpointInput,
    ): Promise<RuntimeCheckpoint> {
      const checkpointId = input.checkpointId ?? crypto.randomUUID();
      const rows = await client.unsafe(
        `/* glirastes:save-checkpoint */
WITH lock_run AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))
),
current_sequence AS MATERIALIZED (
  SELECT COALESCE(max(sequence), 0)::bigint AS sequence
  FROM glirastes_runtime_checkpoints, lock_run
  WHERE environment_id = $1 AND run_id = $2
),
inserted AS (
  INSERT INTO glirastes_runtime_checkpoints (
    environment_id,
    run_id,
    checkpoint_id,
    turn_id,
    agent_revision_id,
    sequence,
    status,
    state
  )
  SELECT $1, $2, $3, $4, $5, $6::bigint + 1, $7, $8::jsonb
  FROM current_sequence
  WHERE sequence = $6::bigint
  RETURNING checkpoint_id, run_id, turn_id, agent_revision_id,
    sequence, status, state, created_at
)
SELECT * FROM inserted`,
        [
          input.environmentId,
          input.runId,
          checkpointId,
          input.turnId,
          input.agentRevisionId,
          input.expectedSequence,
          input.status,
          JSON.stringify(input.state),
        ],
      );
      if (!rows[0]) {
        throw new CheckpointConflictError(
          input.runId,
          input.expectedSequence,
        );
      }
      return mapCheckpoint(rows[0]);
    },

    async loadLatestCheckpoint(input: {
      environmentId: string;
      runId: string;
    }): Promise<RuntimeCheckpoint | null> {
      const rows = await client.unsafe(
        `/* glirastes:load-checkpoint */
SELECT checkpoint_id, run_id, turn_id, agent_revision_id,
  sequence, status, state, created_at
FROM glirastes_runtime_checkpoints
WHERE environment_id = $1 AND run_id = $2
ORDER BY sequence DESC
LIMIT 1`,
        [input.environmentId, input.runId],
      );
      return rows[0] ? mapCheckpoint(rows[0]) : null;
    },

    async claimToolExecution(
      input: ToolExecutionClaimInput,
    ): Promise<ToolExecutionEvidence> {
      const claimToken = crypto.randomUUID();
      const rows = await client.unsafe(
        `/* glirastes:claim-tool-execution */
INSERT INTO glirastes_runtime_tool_executions (
  environment_id,
  run_id,
  idempotency_key,
  tool_uuid,
  input_fingerprint,
  claim_token,
  status
) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
ON CONFLICT (environment_id, run_id, idempotency_key) DO UPDATE
SET idempotency_key = EXCLUDED.idempotency_key
RETURNING *, claim_token = $6 AS claimed`,
        [
          input.environmentId,
          input.runId,
          input.idempotencyKey,
          input.toolUuid,
          input.inputFingerprint,
          claimToken,
        ],
      );
      if (!rows[0]) {
        throw new Error('Tool execution claim could not be persisted.');
      }
      const evidence = mapToolEvidence(rows[0]);
      if (
        evidence.toolUuid !== input.toolUuid
        || evidence.inputFingerprint !== input.inputFingerprint
      ) {
        throw new Error(
          `Idempotency key "${input.idempotencyKey}" was already used for a different tool or input.`,
        );
      }
      return evidence;
    },

    async completeToolExecution(
      input: CompleteToolExecutionInput,
    ): Promise<ToolExecutionEvidence> {
      const rows = await client.unsafe(
        `/* glirastes:complete-tool-execution */
WITH updated AS (
  UPDATE glirastes_runtime_tool_executions
  SET status = $6,
    result = $7::jsonb,
    result_fingerprint = $8,
    completed_at = now()
  WHERE environment_id = $1
    AND run_id = $2
    AND idempotency_key = $3
    AND tool_uuid = $4
    AND input_fingerprint = $5
    AND status = 'pending'
  RETURNING *
)
SELECT *, false AS claimed FROM updated
UNION ALL
SELECT *, false AS claimed
FROM glirastes_runtime_tool_executions
WHERE environment_id = $1
  AND run_id = $2
  AND idempotency_key = $3
  AND tool_uuid = $4
  AND input_fingerprint = $5
  AND status = $6
  AND result_fingerprint = $8
  AND NOT EXISTS (SELECT 1 FROM updated)
LIMIT 1`,
        [
          input.environmentId,
          input.runId,
          input.idempotencyKey,
          input.toolUuid,
          input.inputFingerprint,
          input.status,
          JSON.stringify(input.result),
          input.resultFingerprint,
        ],
      );
      if (!rows[0]) {
        throw new Error(
          `Pending tool execution "${input.idempotencyKey}" was not found.`,
        );
      }
      return mapToolEvidence(rows[0]);
    },
  };
}

export type PostgresRuntimeStore = ReturnType<
  typeof createPostgresRuntimeStore
>;
