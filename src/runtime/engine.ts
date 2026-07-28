export interface RuntimeRunRequest {
  runId: string;
  turnId: string;
  messages: unknown[];
  tools: Record<string, unknown>;
  signal?: AbortSignal;
}

interface RuntimeEventBase {
  runId: string;
  turnId: string;
  occurredAt: string;
}

export type RuntimeEngineEvent =
  | (RuntimeEventBase & { type: 'run.started' })
  | (RuntimeEventBase & {
      type: 'model.step';
      step: number;
      inputTokens?: number;
      outputTokens?: number;
    })
  | (RuntimeEventBase & {
      type: 'tool.started';
      toolName: string;
      toolCallId?: string;
      input?: unknown;
    })
  | (RuntimeEventBase & {
      type: 'tool.completed';
      toolName: string;
      toolCallId?: string;
      result?: unknown;
      durationMs: number;
    })
  | (RuntimeEventBase & {
      type: 'tool.failed';
      toolName: string;
      toolCallId?: string;
      errorClass: string;
      durationMs: number;
    })
  | (RuntimeEventBase & {
      type: 'approval.pending';
      toolName: string;
      toolCallId?: string;
    })
  | (RuntimeEventBase & {
      type: 'checkpoint.saved';
      checkpointId: string;
    })
  | (RuntimeEventBase & {
      type: 'run.completed';
      status: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted';
      reason?: string;
    });

export interface RuntimeEngine {
  run(request: RuntimeRunRequest): AsyncIterable<RuntimeEngineEvent>;
}
