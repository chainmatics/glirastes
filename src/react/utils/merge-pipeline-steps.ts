import type { PipelineStepReport } from '../types.js';

function parseStepTimestamp(value: string): number | null {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Merge incoming pipeline steps with existing stable state.
 *
 * Handles:
 * - Synthetic resume steps (step 0 with stop reason after approval waits)
 * - Timestamp-based conflict resolution for duplicate step numbers
 * - Stable ordering by step number
 *
 * @example
 * ```tsx
 * const [stableSteps, setStableSteps] = useState<PipelineStepReport[]>([]);
 *
 * useEffect(() => {
 *   setStableSteps((prev) => mergePipelineSteps(prev, pipelineSteps));
 * }, [pipelineSteps]);
 * ```
 */
export function mergePipelineSteps(
  previous: PipelineStepReport[],
  incoming: PipelineStepReport[],
): PipelineStepReport[] {
  if (incoming.length === 0) return [];

  const sorted = [...incoming].sort((a, b) => a.stepNumber - b.stepNumber);

  const previousHasWorkflow = previous.some(
    (step) => step.toolCalls.length > 0 || step.requiresApproval,
  );

  const firstIncoming = sorted[0];
  const isSyntheticResumeStep =
    firstIncoming &&
    firstIncoming.stepNumber === 0 &&
    firstIncoming.finishReason === 'stop' &&
    firstIncoming.toolCalls.length === 0 &&
    firstIncoming.toolResults === 0 &&
    !firstIncoming.requiresApproval;

  // After an approval wait, the server sends a synthetic step 0 with finishReason='stop'.
  // Instead of replacing previous steps, append it as a final step.
  if (isSyntheticResumeStep && previousHasWorkflow) {
    const resolved = previous.map((step) =>
      step.requiresApproval
        ? { ...step, requiresApproval: false, pendingApprovals: 0 }
        : step,
    );
    const alreadyFinalized = resolved.some(
      (step) => step.finishReason === 'stop' && step.toolCalls.length === 0,
    );
    if (alreadyFinalized) return resolved;
    return [
      ...resolved,
      { ...firstIncoming, stepNumber: resolved.length },
    ];
  }

  // Also clear approval flags when execution continues with tool calls after approval.
  // This handles cases where followup tools (like suggest_followups) execute after
  // approval is granted, instead of getting a synthetic resume step.
  const previousHadApprovals = previous.some((step) => step.requiresApproval);
  const incomingAllCleared = sorted.every((step) => step.pendingApprovals === 0);
  const shouldClearFlags = previousHadApprovals && incomingAllCleared && sorted.length > 0;

  if (shouldClearFlags) {
    previous = previous.map((step) =>
      step.requiresApproval
        ? { ...step, requiresApproval: false, pendingApprovals: 0 }
        : step,
    );
  }

  // Standard merge: keep newer timestamps when step numbers collide
  const mergedByStep = new Map<number, PipelineStepReport>();
  for (const step of previous) mergedByStep.set(step.stepNumber, step);

  for (const step of sorted) {
    const existing = mergedByStep.get(step.stepNumber);
    if (!existing) {
      mergedByStep.set(step.stepNumber, step);
      continue;
    }
    const existingTs = parseStepTimestamp(existing.createdAt) ?? 0;
    const incomingTs = parseStepTimestamp(step.createdAt) ?? 0;
    if (incomingTs >= existingTs) {
      mergedByStep.set(step.stepNumber, step);
    }
  }

  return Array.from(mergedByStep.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, step]) => step);
}
