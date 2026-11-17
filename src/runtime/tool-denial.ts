import type { ToolAuthorizationResult } from './authorization.js';
import type { BudgetLimitState, BudgetReason } from './budget.js';

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
 * is what the model receives as the tool's error. It keeps the established
 * form `Tool execution denied: <reason> (<tool>)` and names only the reason
 * code and the tool, never policy details or roles. A `budget_exhausted`
 * denial with `budget` names each exhausted limit and its use in plain words
 * instead (see `budgetDenialMessage`); the codes stay on `reason` and `budget`.
 */
export class ToolExecutionDeniedError extends Error {
  readonly reason: ToolDenialReason;
  readonly toolName: string;
  /** `true` when the model gets the denial as a tool error and the turn continues. */
  readonly recoverable: boolean;
  /** For `budget_exhausted`: every exhausted dimension with its limit and use. */
  readonly budget?: ReadonlyArray<BudgetLimitState>;

  constructor(
    reason: ToolDenialReason,
    toolName: string,
    detail: string = toolName,
    budget?: ReadonlyArray<BudgetLimitState>,
  ) {
    super(budget && budget.length > 0
      ? budgetDenialMessage(budget)
      : `Tool execution denied: ${reason} (${detail})`);
    this.name = 'ToolExecutionDeniedError';
    this.reason = reason;
    this.toolName = toolName;
    this.recoverable = RECOVERABLE_REASONS.has(reason);
    if (budget && budget.length > 0) this.budget = Object.freeze(budget.map((state) => ({ ...state })));
  }
}

/** Up to four decimals, no trailing zeros, no grouping: `0.5`, `0.0123`, `40000`. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${formatNumber(Math.round(ms / 100) / 10)} s`;
}

/** `1 tool call`, `8 tool calls`. */
function count(value: number, noun: string): string {
  return `${formatNumber(value)} ${value === 1 ? noun : `${noun}s`}`;
}

/** Plain-word limit and use of one dimension, for the model. */
const LIMIT_PHRASES: Readonly<Record<BudgetReason, (state: BudgetLimitState) => string>> = {
  maxToolCalls: ({ limit, used }) =>
    `the limit of ${count(limit, 'tool call')} per turn is reached (${formatNumber(used)} used)`,
  maxModelSteps: ({ limit, used }) =>
    `the limit of ${count(limit, 'model step')} per turn is reached (${formatNumber(used)} used)`,
  totalTimeoutMs: ({ limit, used }) =>
    `the time limit of ${formatDuration(limit)} per turn is reached (${formatDuration(used)} elapsed)`,
  maxInputTokens: ({ limit, used }) =>
    `the limit of ${count(limit, 'input token')} per turn is reached (${formatNumber(used)} used)`,
  maxOutputTokens: ({ limit, used }) =>
    `the limit of ${count(limit, 'output token')} per turn is reached (${formatNumber(used)} used)`,
  maxEstimatedCostUsd: ({ limit, used }) =>
    `the cost limit of ${formatNumber(limit)} USD per turn is reached (${formatNumber(used)} USD used)`,
  maxRepeatedFingerprint: ({ limit, used }) =>
    `the limit of ${count(limit, 'identical tool call')} with the same result per turn is reached (${count(used, 'repeat')})`,
  maxConsecutiveErrors: ({ limit, used }) =>
    `the limit of ${count(limit, 'consecutive tool error')} per turn is reached (${formatNumber(used)} in a row)`,
};

/** Short user-facing name of each limit, for the chat. */
const LIMIT_LABELS: Readonly<Record<BudgetReason, (limit: number) => string>> = {
  maxToolCalls: (limit) => `Tool call limit for this turn reached (${formatNumber(limit)}).`,
  maxModelSteps: (limit) => `Step limit for this turn reached (${formatNumber(limit)}).`,
  totalTimeoutMs: (limit) => `Time limit for this turn reached (${formatDuration(limit)}).`,
  maxInputTokens: (limit) => `Input token limit for this turn reached (${formatNumber(limit)}).`,
  maxOutputTokens: (limit) => `Output token limit for this turn reached (${formatNumber(limit)}).`,
  maxEstimatedCostUsd: (limit) => `Cost limit for this turn reached (${formatNumber(limit)} USD).`,
  maxRepeatedFingerprint: (limit) => `Limit for repeated identical tool calls reached (${formatNumber(limit)}).`,
  maxConsecutiveErrors: (limit) => `Limit for consecutive tool errors reached (${formatNumber(limit)}).`,
};

/**
 * The model's text for a tool call refused by the turn budget: each
 * exhausted limit with its use, and what to do instead. Numbers only, no
 * tool arguments or principal data.
 */
export function budgetDenialMessage(budget: ReadonlyArray<BudgetLimitState>): string {
  return `Tool call not executed: ${limitPhrases(budget)}. Do not retry in this turn; tell the user which requests are still open.`;
}

function limitPhrases(budget: ReadonlyArray<BudgetLimitState>): string {
  return budget.map((state) => LIMIT_PHRASES[state.dimension](state)).join('; ');
}

/**
 * `read_result`'s hint when the turn budget is used up: the same limit and
 * use as `budgetDenialMessage`, and that the answer is incomplete.
 */
export function readBudgetExhaustedHint(budget: ReadonlyArray<BudgetLimitState>): string {
  return `Not read: ${limitPhrases(budget)}. Do not read further in this turn; answer with what you have `
    + 'and tell the user that the answer is incomplete.';
}

/**
 * The model's instruction for the one tool-free final call at the budget:
 * say plainly that it had to stop, what it finished, what is still open, and
 * that an answer read in parts is incomplete.
 */
export function finalSummaryInstruction(budget: ReadonlyArray<BudgetLimitState>): string {
  return `This turn has to end now: ${limitPhrases(budget)}. No more tools can be called. `
    + 'Write your final answer to the user now: say plainly that you had to stop at a limit, summarize what you finished, '
    + 'and list what is still open. If you were reading a result in parts, say that your answer is incomplete. '
    + 'Do not announce further steps; the user can ask you to continue in a new message.';
}

/** Short texts the chat shows for a denied tool call, per reason. */
const DENIAL_TEXTS: Readonly<Record<Exclude<ToolDenialReason, 'budget_exhausted'>, string>> = {
  principal_role_denied: 'You are not permitted to use this tool.',
  agent_tool_denied: 'This tool is not available in this chat.',
  policy_tool_denied: 'This tool is not available in this chat.',
  manifest_tool_unavailable: 'This tool is not available in this chat.',
  missing_principal: 'The user could not be identified; tool call refused.',
  tenant_mismatch: 'Tool call refused for this account.',
  revoked: 'This tool has been disabled.',
};

/**
 * The user-safe text the chat shows for a denied tool call: a fixed text per
 * reason, for the budget the reached limit. Never the error message itself.
 */
export function toolDenialDisplayText(error: ToolExecutionDeniedError): string {
  if (error.reason === 'budget_exhausted') {
    return error.budget && error.budget.length > 0
      ? error.budget.map((state) => LIMIT_LABELS[state.dimension](state.limit)).join(' ')
      : 'Limit for this turn reached.';
  }
  return DENIAL_TEXTS[error.reason] ?? 'Tool call refused.';
}

export function isRecoverableToolDenial(error: unknown): error is ToolExecutionDeniedError {
  return error instanceof ToolExecutionDeniedError && error.recoverable;
}
