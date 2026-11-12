import type { DelegationBudget, ExecutionBudget } from '../contracts/index.js';

export type LocalLimits = Partial<Omit<ExecutionBudget, 'delegation'>> & {
  delegation?: Partial<DelegationBudget>;
};

export const DEFAULT_LOCAL_LIMITS: ExecutionBudget = {
  maxModelSteps: 6,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 15_000,
  maxInputTokens: 40_000,
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
