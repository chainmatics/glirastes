import type { EnvironmentControlBudgetCeiling, ExecutionBudget } from '../contracts/index.js';

export interface ExecutionUsage {
  modelSteps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  consecutiveErrors: number;
  maxFingerprintRepeats: number;
  elapsedMs: number;
}

export type BudgetReason =
  | 'maxModelSteps'
  | 'maxToolCalls'
  | 'totalTimeoutMs'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'maxEstimatedCostUsd'
  | 'maxRepeatedFingerprint'
  | 'maxConsecutiveErrors';

/** The usage counter each budget dimension is measured by. */
export const BUDGET_USAGE_KEYS: Readonly<Record<BudgetReason, keyof ExecutionUsage>> = Object.freeze({
  maxModelSteps: 'modelSteps',
  maxToolCalls: 'toolCalls',
  totalTimeoutMs: 'elapsedMs',
  maxInputTokens: 'inputTokens',
  maxOutputTokens: 'outputTokens',
  maxEstimatedCostUsd: 'estimatedCostUsd',
  maxRepeatedFingerprint: 'maxFingerprintRepeats',
  maxConsecutiveErrors: 'consecutiveErrors',
});

/**
 * The limits after which the turn still gets one tool-free final summary
 * call: they limit tools, and the summary calls none.
 */
export const FINAL_SUMMARY_REASONS: ReadonlySet<BudgetReason> = new Set<BudgetReason>([
  'maxToolCalls',
  'maxRepeatedFingerprint',
  'maxConsecutiveErrors',
]);

/** One budget dimension with its limit and what the turn has used of it. */
export interface BudgetLimitState {
  dimension: BudgetReason;
  limit: number;
  used: number;
}

export interface BudgetEvaluation {
  state: 'within-budget' | 'soft-limit' | 'hard-limit';
  reasons: BudgetReason[];
}

export class ExecutionBudgetTracker {
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly fingerprints = new Map<string, number>();
  private finalSummaryClaimed = false;
  private counters = {
    modelSteps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    consecutiveErrors: 0,
    maxFingerprintRepeats: 0,
  };

  constructor(
    readonly budget: ExecutionBudget,
    clock: { now?: () => number; startedAtMs?: number } = {},
  ) {
    this.now = clock.now ?? Date.now;
    this.startedAtMs = clock.startedAtMs ?? this.now();
  }

  get usage(): ExecutionUsage {
    return {
      ...this.counters,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
    };
  }

  recordModelStep(): void {
    this.counters.modelSteps += 1;
  }

  recordToolCall(): void {
    this.counters.toolCalls += 1;
  }

  recordTokens(inputTokens: number, outputTokens: number): void {
    this.counters.inputTokens += this.requireFiniteNonnegative(inputTokens, 'inputTokens');
    this.counters.outputTokens += this.requireFiniteNonnegative(outputTokens, 'outputTokens');
  }

  recordEstimatedCost(costUsd: number): void {
    this.counters.estimatedCostUsd += this.requireFiniteNonnegative(
      costUsd,
      'estimatedCostUsd',
    );
  }

  recordError(): void {
    this.counters.consecutiveErrors += 1;
  }

  recordSuccess(): void {
    this.counters.consecutiveErrors = 0;
  }

  recordFingerprint(fingerprint: string): void {
    const count = (this.fingerprints.get(fingerprint) ?? 0) + 1;
    this.fingerprints.set(fingerprint, count);
    this.counters.maxFingerprintRepeats = Math.max(
      this.counters.maxFingerprintRepeats,
      count,
    );
  }

  /** Limit and current use of the given dimensions, in their order. */
  limitStates(dimensions: ReadonlyArray<BudgetReason>): BudgetLimitState[] {
    const usage = this.usage;
    return dimensions.map((dimension) => ({
      dimension,
      limit: this.budget[dimension],
      used: usage[BUDGET_USAGE_KEYS[dimension]],
    }));
  }

  evaluate(): BudgetEvaluation {
    const usage = this.usage;
    const dimensions = (Object.keys(BUDGET_USAGE_KEYS) as BudgetReason[]).map(
      (reason): [BudgetReason, number, number] => [
        reason,
        usage[BUDGET_USAGE_KEYS[reason]],
        this.budget[reason],
      ],
    );

    const hard = dimensions
      .filter(([, value, limit]) => limit === 0 ? value > 0 : value >= limit)
      .map(([reason]) => reason);
    if (hard.length > 0) return { state: 'hard-limit', reasons: hard };

    const soft = dimensions
      .filter(([, value, limit]) => limit > 0 && value / limit >= 0.8)
      .map(([reason]) => reason);
    if (soft.length > 0) return { state: 'soft-limit', reasons: soft };

    return { state: 'within-budget', reasons: [] };
  }

  /**
   * Grants the one tool-free final summary call at the hard limit, once, and
   * only when every reached limit is a tool limit (see
   * `FINAL_SUMMARY_REASONS`): a limit on model steps, tokens, cost or time
   * would be exceeded by that call itself.
   */
  claimFinalSummary(): boolean {
    const evaluation = this.evaluate();
    if (
      evaluation.state !== 'hard-limit'
      || this.finalSummaryClaimed
      || !evaluation.reasons.every((reason) => FINAL_SUMMARY_REASONS.has(reason))
    ) {
      return false;
    }
    this.finalSummaryClaimed = true;
    return true;
  }

  private requireFiniteNonnegative(value: number, field: string): number {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${field} must be a finite nonnegative number`);
    }
    return value;
  }
}

/** The budget lowered field by field to a signed ceiling; a ceiling never raises a limit. */
export function applyBudgetCeiling(
  budget: ExecutionBudget,
  ceiling: EnvironmentControlBudgetCeiling | undefined,
): ExecutionBudget {
  if (!ceiling) return budget;
  const next = { ...budget };
  for (const field of Object.keys(ceiling) as Array<keyof EnvironmentControlBudgetCeiling>) {
    const value = ceiling[field];
    if (value === undefined) continue;
    // A broken value can only tighten: NaN or a negative limit allows nothing.
    next[field] = Number.isNaN(value) || value < 0 ? 0 : Math.min(budget[field], value);
  }
  next.toolTimeoutMs = Math.min(next.toolTimeoutMs, next.totalTimeoutMs);
  return next;
}
