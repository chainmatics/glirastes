import type { ExecutionBudget } from '../contracts/index.js';

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

  evaluate(): BudgetEvaluation {
    const usage = this.usage;
    const dimensions: Array<[BudgetReason, number, number]> = [
      ['maxModelSteps', usage.modelSteps, this.budget.maxModelSteps],
      ['maxToolCalls', usage.toolCalls, this.budget.maxToolCalls],
      ['totalTimeoutMs', usage.elapsedMs, this.budget.totalTimeoutMs],
      ['maxInputTokens', usage.inputTokens, this.budget.maxInputTokens],
      ['maxOutputTokens', usage.outputTokens, this.budget.maxOutputTokens],
      ['maxEstimatedCostUsd', usage.estimatedCostUsd, this.budget.maxEstimatedCostUsd],
      [
        'maxRepeatedFingerprint',
        usage.maxFingerprintRepeats,
        this.budget.maxRepeatedFingerprint,
      ],
      [
        'maxConsecutiveErrors',
        usage.consecutiveErrors,
        this.budget.maxConsecutiveErrors,
      ],
    ];

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

  claimFinalSummary(): boolean {
    if (this.evaluate().state !== 'hard-limit' || this.finalSummaryClaimed) {
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
