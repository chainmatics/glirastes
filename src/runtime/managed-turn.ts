import type {
  Principal,
  SecurityRevocation,
} from '../contracts/index.js';
import type {
  AiSdkToolCall,
  AiSdkToolFailure,
  AiSdkToolSuccess,
} from './ai-sdk/engine.js';
import { authorizeToolCall, principalDenialReason } from './authorization.js';
import { modelFacingToolName } from './local-tool-bindings.js';
import {
  ExecutionBudgetTracker,
  type BudgetEvaluation,
  type ExecutionUsage,
} from './budget.js';
import { createExecutionFingerprint } from './fingerprint.js';
import { isRecoverableToolDenial, ToolExecutionDeniedError } from './tool-denial.js';
import { toolResultFailure, toolResultForFingerprint } from './tool-failure.js';
import {
  isToolRevoked,
  type TurnSnapshot,
} from './turn-snapshot.js';

export interface ManagedTurnBudgetSignal {
  evaluation: BudgetEvaluation;
  usage: ExecutionUsage;
}

export interface ManagedTurnGuardOptions {
  snapshot: TurnSnapshot;
  resolvePrincipal: () => Principal | undefined | Promise<Principal | undefined>;
  loadRevocations?: (
    snapshot: TurnSnapshot,
  ) => ReadonlyArray<SecurityRevocation> | Promise<ReadonlyArray<SecurityRevocation>>;
  onBudgetSignal?: (
    signal: ManagedTurnBudgetSignal,
  ) => void | Promise<void>;
}

export interface ManagedTurnGuard {
  readonly snapshot: TurnSnapshot;
  readonly tracker: ExecutionBudgetTracker;
  readonly toolTimeoutMs: number;
  beforeToolCall(call: AiSdkToolCall): Promise<void>;
  afterModelStep(usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  }): Promise<void>;
  afterToolCall(call: AiSdkToolSuccess): Promise<void>;
  onToolError(call: AiSdkToolFailure): Promise<void>;
  resolveApproval(call: AiSdkToolCall): Promise<boolean>;
}

export function createManagedTurnGuard(
  options: ManagedTurnGuardOptions,
): ManagedTurnGuard {
  const tracker = new ExecutionBudgetTracker(options.snapshot.budget);

  // Calls arrive under the model-safe encoding of the signed manifest name.
  const findManifestTool = (toolName: string) => options.snapshot.manifestRevision.tools.find(
    (candidate) => modelFacingToolName(candidate.name) === toolName,
  );

  /**
   * The conditions that end the turn. They are checked before any recoverable
   * denial, and independently of the tool, so a tool that is unknown or not
   * permitted never keeps a turn alive for a principal that no longer exists,
   * belongs to another tenant, or runs on a revoked revision.
   */
  const assertTurnMayContinue = async (
    principal: Principal | undefined,
    toolId: string | undefined,
    toolName: string,
  ) => {
    const principalDenial = principalDenialReason({
      principal,
      agentRevision: options.snapshot.agentRevision,
      manifestRevision: options.snapshot.manifestRevision,
      policyRevision: options.snapshot.policyRevision,
    });
    if (principalDenial) {
      throw new ToolExecutionDeniedError(principalDenial, toolName);
    }
    const revocations = await options.loadRevocations?.(options.snapshot) ?? [];
    if (isToolRevoked(options.snapshot, toolId, revocations)) {
      throw new ToolExecutionDeniedError('revoked', toolName);
    }
  };

  const authorize = async (call: AiSdkToolCall) => {
    const principal = await options.resolvePrincipal();
    const manifestTool = findManifestTool(call.toolName);
    await assertTurnMayContinue(principal, manifestTool?.toolId, call.toolName);

    // Only from here on may a denial be recoverable.
    if (!manifestTool) {
      throw new ToolExecutionDeniedError('manifest_tool_unavailable', call.toolName);
    }
    const authorization = authorizeToolCall({
      principal,
      agentRevision: options.snapshot.agentRevision,
      manifestRevision: options.snapshot.manifestRevision,
      policyRevision: options.snapshot.policyRevision,
      toolId: manifestTool.toolId,
    });
    if (!authorization.allowed) {
      throw new ToolExecutionDeniedError(authorization.reason, call.toolName);
    }

    return { authorization, manifestTool };
  };

  const emitBudgetSignal = async () => {
    const evaluation = tracker.evaluate();
    if (evaluation.state !== 'within-budget') {
      await options.onBudgetSignal?.({
        evaluation,
        usage: tracker.usage,
      });
    }
    return evaluation;
  };

  return {
    snapshot: options.snapshot,
    tracker,
    toolTimeoutMs: options.snapshot.budget.toolTimeoutMs,

    async beforeToolCall(call) {
      const currentBudget = await emitBudgetSignal();
      if (currentBudget.state === 'hard-limit') {
        throw new ToolExecutionDeniedError(
          'budget_exhausted',
          call.toolName,
          currentBudget.reasons.join(','),
        );
      }

      try {
        await authorize(call);
      } catch (error) {
        if (isRecoverableToolDenial(error)) {
          // The model called the tool and gets the denial as its result: a
          // call and an error, like in the turn metrics, so repeated denied
          // calls end at maxConsecutiveErrors (or maxToolCalls).
          tracker.recordToolCall();
          tracker.recordError();
          await emitBudgetSignal();
        }
        throw error;
      }
      tracker.recordToolCall();
      await emitBudgetSignal();
    },

    async afterModelStep(usage) {
      tracker.recordModelStep();
      tracker.recordTokens(usage.inputTokens, usage.outputTokens);
      if (usage.estimatedCostUsd !== undefined) {
        tracker.recordEstimatedCost(usage.estimatedCostUsd);
      }
      await emitBudgetSignal();
    },

    async afterToolCall(call) {
      const { manifestTool } = await authorize(call);
      tracker.recordFingerprint(createExecutionFingerprint({
        toolId: manifestTool.toolId,
        arguments: call.input,
        result: toolResultForFingerprint(call.result),
      }));
      const failure = toolResultFailure(call.result);
      if (failure === 'error') {
        tracker.recordError();
      } else if (failure === undefined) {
        tracker.recordSuccess();
      }
      // An expected failure neither counts as an error nor resets the run.
      await emitBudgetSignal();
    },

    async onToolError() {
      tracker.recordError();
      await emitBudgetSignal();
    },

    async resolveApproval(call) {
      const { authorization } = await authorize(call);
      return authorization.requiresApproval;
    },
  };
}
