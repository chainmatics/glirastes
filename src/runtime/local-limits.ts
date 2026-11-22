import type { DelegationBudget, ExecutionBudget } from '../contracts/index.js';

export type LocalLimits = Partial<Omit<ExecutionBudget, 'delegation'>> & {
  delegation?: Partial<DelegationBudget>;
};

/**
 * Defaults of the local budget. 10 model steps: a typical read-plus-planning
 * request (a plan, three reads, plan updates, the answer) needs 7 to 8.
 * Built-in tools such as `update_plan` count no tool call, so 8 tool calls
 * stay enough for it. 60,000 input tokens: every step sends the turn again,
 * so 10 steps of such a request use about 50,000 (6 steps measured 27,000).
 */
export const DEFAULT_LOCAL_LIMITS: ExecutionBudget = {
  maxModelSteps: 10,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 15_000,
  maxInputTokens: 60_000,
  maxOutputTokens: 4_000,
  maxEstimatedCostUsd: 0.5,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function resolveLocalLimits(limits?: LocalLimits): ExecutionBudget {
  return {
    ...DEFAULT_LOCAL_LIMITS,
    ...defined(limits),
    delegation: { ...DEFAULT_LOCAL_LIMITS.delegation, ...defined(limits?.delegation) },
  };
}
