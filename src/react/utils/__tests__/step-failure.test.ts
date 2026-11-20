import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';
import { readStepFailures, stepFailureText, STEP_FAILURE_CODES, type StepFailure } from '../step-failure.js';
import { ENDPOINT_PATH_NOT_ALLOWED_ERROR, ENDPOINT_PATH_NOT_RELATIVE_ERROR } from '../../../runtime/tool-failure.js';
import { ToolExecutionDeniedError, toolDenialDisplayText, type ToolDenialReason } from '../../../runtime/tool-denial.js';
import type { BudgetReason } from '../../../runtime/budget.js';
import {
  GENERIC_STREAM_ERROR_TEXT,
  INVALID_TOOL_INPUT_TEXT,
  UNAVAILABLE_TOOL_TEXT,
} from '../../../server/adapters/nextjs/stream-error-text.js';
import { APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS } from '../../../server/adapters/nextjs/approval-subject-lookup.js';
import { createFetchInternalApiCaller } from '../../../server/core/index.js';

const DENIAL_REASONS: ToolDenialReason[] = [
  'principal_role_denied', 'agent_tool_denied', 'policy_tool_denied', 'manifest_tool_unavailable',
  'missing_principal', 'tenant_mismatch', 'revoked', 'budget_exhausted',
];
const BUDGET_DIMENSIONS: BudgetReason[] = [
  'maxToolCalls', 'maxModelSteps', 'totalTimeoutMs', 'maxInputTokens', 'maxOutputTokens',
  'maxEstimatedCostUsd', 'maxRepeatedFingerprint', 'maxConsecutiveErrors',
];
const budgetText = (dimensions: BudgetReason[], limit = 8) => toolDenialDisplayText(new ToolExecutionDeniedError(
  'budget_exhausted', 'tasks_list', 'tasks_list', dimensions.map((dimension) => ({ dimension, limit, used: limit }))));

async function endpointFailedText(status: number): Promise<string> {
  const call = createFetchInternalApiCaller({ baseUrl: 'https://api.example', fetchImpl: async () => new Response(null, { status }) });
  const result = await call({ method: 'GET', path: '/tasks' });
  return (result as { error: string }).error;
}

/** Fixed texts the memory tools and the endpoint caller write; read from their source so a reworded text fails here. */
function sourceTexts(): string[] {
  const memory = readFileSync(resolve(import.meta.dirname, '../../../server/adapters/nextjs/chat-memory.ts'), 'utf8');
  const core = readFileSync(resolve(import.meta.dirname, '../../../server/core/index.ts'), 'utf8');
  const memoryTexts = [
    'This kind of memory is not available.',
    'The note could not be saved.',
    'The note text does not match this id. Pass the note exactly as shown in the memory block.',
    'The note could not be removed.',
    'No note with this id.',
  ];
  for (const text of memoryTexts) expect(memory, text).toContain(`'${text}'`);
  expect(memory).toContain('`Memory is full (${set.max} notes). Remove a note that is no longer needed first.`');
  expect(core).toContain("'Endpoint timed out'");
  expect(core).toContain("'Endpoint response exceeds maxResponseBytes'");
  expect(core).toContain('`Error in ${name}: ${errorMessage}`');
  return [
    ...memoryTexts,
    'Memory is full (20 notes). Remove a note that is no longer needed first.',
    'Error in tasks_list: Endpoint timed out',
    'Error in tasks_list: Endpoint response exceeds maxResponseBytes',
  ];
}

async function sdkTexts(): Promise<string[]> {
  return [
    GENERIC_STREAM_ERROR_TEXT,
    INVALID_TOOL_INPUT_TEXT,
    UNAVAILABLE_TOOL_TEXT,
    ...DENIAL_REASONS.filter((reason) => reason !== 'budget_exhausted')
      .map((reason) => toolDenialDisplayText(new ToolExecutionDeniedError(reason, 'tasks_list'))),
    toolDenialDisplayText(new ToolExecutionDeniedError('budget_exhausted', 'tasks_list')),
    ...BUDGET_DIMENSIONS.map((dimension) => budgetText([dimension])),
    budgetText(['totalTimeoutMs'], 90_000),
    budgetText(['maxEstimatedCostUsd'], 0.5),
    budgetText(['maxToolCalls', 'maxConsecutiveErrors']),
    ...Object.values(APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS),
    ENDPOINT_PATH_NOT_RELATIVE_ERROR,
    ENDPOINT_PATH_NOT_ALLOWED_ERROR,
    await endpointFailedText(503),
    ...sourceTexts(),
  ];
}

describe('readStepFailures', () => {
  it('recognizes every fixed failure text the SDK writes, and renders it in English exactly as before', async () => {
    for (const text of await sdkTexts()) {
      const failures = readStepFailures(text);
      expect(failures, text).toBeDefined();
      expect(stepFailureText(failures!, DEFAULT_LOCALE), text).toBe(text);
    }
  });

  it('renders every SDK text in German without English left over', async () => {
    for (const text of await sdkTexts()) {
      const german = stepFailureText(readStepFailures(text)!, deChatLocale);
      expect(german, text).not.toBe(text);
    }
    expect(stepFailureText(readStepFailures(await endpointFailedText(503))!, deChatLocale)).toBe('Endpunkt fehlgeschlagen (503)');
    expect(stepFailureText(readStepFailures(budgetText(['maxToolCalls', 'maxConsecutiveErrors']))!, deChatLocale))
      .toBe('Limit für Tool-Aufrufe in diesem Durchlauf erreicht (8). Limit für aufeinanderfolgende Tool-Fehler erreicht (8).');
  });

  it('reads the values of a text with values', async () => {
    expect(readStepFailures(await endpointFailedText(404))).toEqual([{ code: 'endpoint-failed', values: { status: '404' } }]);
    expect(readStepFailures('Error in tasks_list: Endpoint timed out'))
      .toEqual([{ code: 'endpoint-timeout', values: { tool: 'tasks_list' } }]);
    expect(readStepFailures(budgetText(['totalTimeoutMs'], 90_000)))
      .toEqual([{ code: 'limit-time', values: { limit: '90 s' } }]);
  });

  it('leaves a text the SDK did not write alone: backend or tool content, a text from a newer server', () => {
    for (const text of [
      'Aufgabe ist gesperrt',
      'Error in tasks_list: Task is locked',
      'Endpoint failed',
      'Tool call limit for this turn reached (8). And something else.',
      'A brand-new failure text from a newer server.',
      '',
    ]) {
      expect(readStepFailures(text), text).toBeUndefined();
    }
  });
});

describe('stepFailureText', () => {
  it('has a text for every code in every built-in language', () => {
    for (const code of STEP_FAILURE_CODES) {
      const failure: StepFailure = { code, values: { status: '500', tool: 'x', limit: '3', max: '20' } };
      expect(stepFailureText([failure], DEFAULT_LOCALE), code).not.toBe('');
      expect(stepFailureText([failure], deChatLocale), code).not.toBe(stepFailureText([failure], DEFAULT_LOCALE));
    }
  });

  it('shows the generic failure text for a code it does not know', () => {
    const unknown = [{ code: 'quota-frozen' } as unknown as StepFailure];
    expect(stepFailureText(unknown, DEFAULT_LOCALE)).toBe(DEFAULT_LOCALE.activityFailureGeneric);
    expect(stepFailureText(unknown, deChatLocale)).toBe('KI-Anfrage fehlgeschlagen');
  });

  it("takes the app's own text of a key, and English for a key a partial locale lacks", () => {
    const failures = readStepFailures('Endpoint failed (500)')!;
    expect(stepFailureText(failures, { ...deChatLocale, activityFailureEndpointFailed: 'Server antwortet nicht ({status})' }))
      .toBe('Server antwortet nicht (500)');
    expect(stepFailureText(failures, {})).toBe('Endpoint failed (500)');
  });
});
