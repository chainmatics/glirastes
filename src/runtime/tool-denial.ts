import type { ToolAuthorizationResult } from './authorization.js';

type AuthorizationDenialReason = Extract<ToolAuthorizationResult, { allowed: false }>['reason'];

/** Why the managed turn guard refused a tool call. */
export type ToolDenialReason = AuthorizationDenialReason | 'revoked' | 'budget_exhausted';

/**
 * Denials the model receives as a failed tool call, after which the turn
 * continues: the tool is not available to this principal or this agent
 * revision. Every other reason (`missing_principal`, `tenant_mismatch`,
 * `revoked`, `budget_exhausted`) ends the turn as before.
 */
const RECOVERABLE_REASONS: ReadonlySet<ToolDenialReason> = new Set<ToolDenialReason>([
  'agent_tool_denied',
  'manifest_tool_unavailable',
  'policy_tool_denied',
  'principal_role_denied',
]);

/**
 * Thrown by the managed turn guard when it refuses a tool call. The message
 * keeps the established form `Tool execution denied: <reason> (<detail>)`;
 * it names only the reason code and the tool (or the budget reasons), never
 * policy details or roles.
 */
export class ToolExecutionDeniedError extends Error {
  readonly reason: ToolDenialReason;
  readonly toolName: string;
  /** `true` when the model gets the denial as a tool error and the turn continues. */
  readonly recoverable: boolean;

  constructor(reason: ToolDenialReason, toolName: string, detail: string = toolName) {
    super(`Tool execution denied: ${reason} (${detail})`);
    this.name = 'ToolExecutionDeniedError';
    this.reason = reason;
    this.toolName = toolName;
    this.recoverable = RECOVERABLE_REASONS.has(reason);
  }
}

export function isRecoverableToolDenial(error: unknown): error is ToolExecutionDeniedError {
  return error instanceof ToolExecutionDeniedError && error.recoverable;
}
