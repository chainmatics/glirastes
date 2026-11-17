import { describe, expect, it } from 'vitest';
import { ExecutionBudgetTracker, type BudgetLimitState } from '../budget.js';
import {
  budgetDenialMessage,
  ToolExecutionDeniedError,
  toolDenialDisplayText,
  type ToolDenialReason,
} from '../tool-denial.js';
import { DEFAULT_LOCAL_LIMITS as localLimits } from '../local-limits.js';

const TAIL = '. Do not retry in this turn; tell the user which requests are still open.';

const cases: Array<[BudgetLimitState, string, string]> = [
  [{ dimension: 'maxToolCalls', limit: 8, used: 8 },
    'the limit of 8 tool calls per turn is reached (8 used)',
    'Tool call limit for this turn reached (8).'],
  [{ dimension: 'maxModelSteps', limit: 6, used: 6 },
    'the limit of 6 model steps per turn is reached (6 used)',
    'Step limit for this turn reached (6).'],
  [{ dimension: 'totalTimeoutMs', limit: 60_000, used: 61_234 },
    'the time limit of 60 s per turn is reached (61.2 s elapsed)',
    'Time limit for this turn reached (60 s).'],
  [{ dimension: 'maxInputTokens', limit: 40_000, used: 41_002 },
    'the limit of 40000 input tokens per turn is reached (41002 used)',
    'Input token limit for this turn reached (40000).'],
  [{ dimension: 'maxOutputTokens', limit: 4_000, used: 4_100 },
    'the limit of 4000 output tokens per turn is reached (4100 used)',
    'Output token limit for this turn reached (4000).'],
  [{ dimension: 'maxEstimatedCostUsd', limit: 0.5, used: 0.51234567 },
    'the cost limit of 0.5 USD per turn is reached (0.5123 USD used)',
    'Cost limit for this turn reached (0.5 USD).'],
  [{ dimension: 'maxRepeatedFingerprint', limit: 3, used: 3 },
    'the limit of 3 identical tool calls with the same result per turn is reached (3 repeats)',
    'Limit for repeated identical tool calls reached (3).'],
  [{ dimension: 'maxConsecutiveErrors', limit: 3, used: 3 },
    'the limit of 3 consecutive tool errors per turn is reached (3 in a row)',
    'Limit for consecutive tool errors reached (3).'],
];

describe('budget denial texts', () => {
  it.each(cases)('names limit and use of %o for the model and the chat', (state, model, chat) => {
    const error = new ToolExecutionDeniedError('budget_exhausted', 'tasks_list', state.dimension, [state]);
    expect(error.message).toBe(`Tool call not executed: ${model}${TAIL}`);
    expect(toolDenialDisplayText(error)).toBe(chat);
    expect(error).toMatchObject({ reason: 'budget_exhausted', recoverable: false, budget: [state] });
  });

  it('uses the singular for a limit of one', () => {
    expect(budgetDenialMessage([{ dimension: 'maxToolCalls', limit: 1, used: 1 }]))
      .toBe(`Tool call not executed: the limit of 1 tool call per turn is reached (1 used)${TAIL}`);
  });

  it('names every exhausted limit', () => {
    const error = new ToolExecutionDeniedError('budget_exhausted', 'tasks_list', 'maxToolCalls,maxConsecutiveErrors', [
      { dimension: 'maxToolCalls', limit: 8, used: 8 },
      { dimension: 'maxConsecutiveErrors', limit: 3, used: 3 },
    ]);
    expect(error.message).toBe('Tool call not executed: the limit of 8 tool calls per turn is reached (8 used); '
      + `the limit of 3 consecutive tool errors per turn is reached (3 in a row)${TAIL}`);
    expect(toolDenialDisplayText(error))
      .toBe('Tool call limit for this turn reached (8). Limit for consecutive tool errors reached (3).');
  });

  it('keeps the established message without budget states', () => {
    const error = new ToolExecutionDeniedError('budget_exhausted', 'tasks_list', 'maxToolCalls');
    expect(error.message).toBe('Tool execution denied: budget_exhausted (maxToolCalls)');
    expect(error.budget).toBeUndefined();
    expect(toolDenialDisplayText(error)).toBe('Limit for this turn reached.');
  });
});

describe('denial texts for the chat', () => {
  it.each<[ToolDenialReason, string]>([
    ['principal_role_denied', 'You are not permitted to use this tool.'],
    ['agent_tool_denied', 'This tool is not available in this chat.'],
    ['policy_tool_denied', 'This tool is not available in this chat.'],
    ['manifest_tool_unavailable', 'This tool is not available in this chat.'],
    ['missing_principal', 'The user could not be identified; tool call refused.'],
    ['tenant_mismatch', 'Tool call refused for this account.'],
    ['revoked', 'This tool has been disabled.'],
  ])('%s: a fixed text, never the message', (reason, text) => {
    const error = new ToolExecutionDeniedError(reason, 'tasks_list');
    expect(error.message).toBe(`Tool execution denied: ${reason} (tasks_list)`);
    expect(toolDenialDisplayText(error)).toBe(text);
  });
});

describe('ExecutionBudgetTracker.limitStates', () => {
  it('reads limit and use of each dimension', () => {
    const tracker = new ExecutionBudgetTracker(localLimits, { now: () => 1_500, startedAtMs: 1_000 });
    tracker.recordToolCall();
    tracker.recordError();
    tracker.recordTokens(10, 2);
    expect(tracker.limitStates(['maxToolCalls', 'maxConsecutiveErrors', 'totalTimeoutMs', 'maxOutputTokens'])).toEqual([
      { dimension: 'maxToolCalls', limit: localLimits.maxToolCalls, used: 1 },
      { dimension: 'maxConsecutiveErrors', limit: localLimits.maxConsecutiveErrors, used: 1 },
      { dimension: 'totalTimeoutMs', limit: localLimits.totalTimeoutMs, used: 500 },
      { dimension: 'maxOutputTokens', limit: localLimits.maxOutputTokens, used: 2 },
    ]);
  });
});
