import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';
import {
  readStepFailures,
  stepFailureText,
  STEP_FAILURE_CODES,
  type StepFailure,
  type StepFailureSource,
} from '../step-failure.js';
import { ENDPOINT_PATH_NOT_ALLOWED_ERROR, ENDPOINT_PATH_NOT_RELATIVE_ERROR } from '../../../runtime/tool-failure.js';
import { ToolExecutionDeniedError, toolDenialDisplayText, type ToolDenialReason } from '../../../runtime/tool-denial.js';
import type { BudgetReason } from '../../../runtime/budget.js';
import {
  GENERIC_STREAM_ERROR_TEXT,
  INVALID_TOOL_INPUT_TEXT,
  UNAVAILABLE_TOOL_TEXT,
} from '../../../server/adapters/nextjs/stream-error-text.js';
import { APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS } from '../../../server/adapters/nextjs/approval-subject-lookup.js';
import {
  createFetchInternalApiCaller,
  endpointToolToTool,
  toolToAiTool,
  type EndpointToolContext,
} from '../../../server/core/index.js';
import { defineEndpointTool } from '../../../types.js';
import { MEMORY_FORGET_TOOL_NAME, MEMORY_REMEMBER_TOOL_NAME } from '../../../contracts/memory.js';

/** Every denial reason; a new reason fails compilation here until it has a German text. */
const DENIAL_GERMAN = {
  principal_role_denied: 'Du darfst dieses Tool nicht verwenden.',
  agent_tool_denied: 'Dieses Tool ist in diesem Chat nicht verfügbar.',
  policy_tool_denied: 'Dieses Tool ist in diesem Chat nicht verfügbar.',
  manifest_tool_unavailable: 'Dieses Tool ist in diesem Chat nicht verfügbar.',
  missing_principal: 'Der Nutzer konnte nicht erkannt werden; Tool-Aufruf abgelehnt.',
  tenant_mismatch: 'Tool-Aufruf für dieses Konto abgelehnt.',
  revoked: 'Dieses Tool wurde deaktiviert.',
  budget_exhausted: 'Limit für diesen Durchlauf erreicht.',
} satisfies Record<ToolDenialReason, string>;

/** Every budget dimension; a new dimension fails compilation here. `[limit, German text]`. */
const BUDGET_GERMAN = {
  maxToolCalls: [8, 'Limit für Tool-Aufrufe in diesem Durchlauf erreicht (8).'],
  maxModelSteps: [12, 'Schrittlimit für diesen Durchlauf erreicht (12).'],
  totalTimeoutMs: [1_500, 'Zeitlimit für diesen Durchlauf erreicht (1,5 s).'],
  maxInputTokens: [40_000, 'Limit für Eingabe-Tokens in diesem Durchlauf erreicht (40000).'],
  maxOutputTokens: [4_000, 'Limit für Ausgabe-Tokens in diesem Durchlauf erreicht (4000).'],
  maxEstimatedCostUsd: [0.5, 'Kostenlimit für diesen Durchlauf erreicht (0,5 USD).'],
  maxRepeatedFingerprint: [3, 'Limit für wiederholte gleiche Tool-Aufrufe erreicht (3).'],
  maxConsecutiveErrors: [4, 'Limit für aufeinanderfolgende Tool-Fehler erreicht (4).'],
} satisfies Record<BudgetReason, readonly [number, string]>;

const deniedText = (reason: ToolDenialReason) => toolDenialDisplayText(new ToolExecutionDeniedError(reason, 'tasks_list'));
const budgetText = (states: Array<[BudgetReason, number]>) => toolDenialDisplayText(new ToolExecutionDeniedError(
  'budget_exhausted', 'tasks_list', 'tasks_list', states.map(([dimension, limit]) => ({ dimension, limit, used: limit }))));

const fromStream = { source: 'error-text', toolName: 'tasks_list' } as const;
const fromOutput = (toolName = 'tasks_create', status?: number) => ({
  source: 'output' as StepFailureSource,
  toolName,
  ...(status === undefined ? {} : { status }),
});

const definition = defineEndpointTool({
  id: 'tasks.create',
  toolName: 'tasks_create',
  description: 'Create a task.',
  method: 'POST',
  path: '/api/tasks',
  inputSchema: z.object({ title: z.string() }).strict(),
});

/** The `error` of an endpoint tool's result, through the real caller and `toolToAiTool`. */
async function endpointError(fetchImpl: typeof fetch, options: { timeoutMs?: number; maxResponseBytes?: number } = {}): Promise<string> {
  const callEndpoint = createFetchInternalApiCaller({ baseUrl: 'https://api.example', fetchImpl, ...options });
  const context: EndpointToolContext = { currentDate: new Date('2026-10-05T10:00:00.000Z'), locale: 'en', callEndpoint };
  const result = await toolToAiTool(endpointToolToTool(definition), context, 'tasks_create').execute({ title: 'x' });
  return (result as { error: string }).error;
}

const neverAnswers: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
});
const statusOnly = (status: number): typeof fetch => async () => new Response(null, { status });
const bigBody: typeof fetch = async () => new Response('x'.repeat(100), { status: 200 });

/** The memory tools' texts: no exported constant list exists, so they are read from the source; a rewording fails here. */
function memoryTexts(): Array<[string, string, string]> {
  const memory = readFileSync(resolve(import.meta.dirname, '../../../server/adapters/nextjs/chat-memory.ts'), 'utf8');
  const texts: Array<[string, string, string]> = [
    [MEMORY_REMEMBER_TOOL_NAME, 'This kind of memory is not available.', 'Diese Art von Gedächtnis ist nicht verfügbar.'],
    [MEMORY_REMEMBER_TOOL_NAME, 'The note could not be saved.', 'Die Notiz konnte nicht gespeichert werden.'],
    [MEMORY_FORGET_TOOL_NAME, 'The note text does not match this id. Pass the note exactly as shown in the memory block.',
      'Der Notiztext passt nicht zu dieser ID. Gib die Notiz genau so an, wie sie im Gedächtnisblock steht.'],
    [MEMORY_FORGET_TOOL_NAME, 'The note could not be removed.', 'Die Notiz konnte nicht entfernt werden.'],
    [MEMORY_FORGET_TOOL_NAME, 'No note with this id.', 'Keine Notiz mit dieser ID.'],
  ];
  for (const [, text] of texts) expect(memory, text).toContain(`'${text}'`);
  expect(memory).toContain('`Memory is full (${set.max} notes). Remove a note that is no longer needed first.`');
  return [
    ...texts,
    [MEMORY_REMEMBER_TOOL_NAME, 'Memory is full (20 notes). Remove a note that is no longer needed first.',
      'Das Gedächtnis ist voll (20 Notizen). Entferne zuerst eine Notiz, die nicht mehr gebraucht wird.'],
  ];
}

/** `[text, where it arrives, German]` for every fixed text the SDK writes into a step. */
async function sdkTexts(): Promise<Array<[string, Parameters<typeof readStepFailures>[1], string]>> {
  return [
    [GENERIC_STREAM_ERROR_TEXT, fromStream, 'KI-Anfrage fehlgeschlagen'],
    [INVALID_TOOL_INPUT_TEXT, fromStream,
      'Der Assistent hat ungültige Angaben für dieses Tool gesendet; ihm wurde gesagt, was zu korrigieren ist.'],
    [UNAVAILABLE_TOOL_TEXT, fromStream, 'Dieses Tool ist in diesem Chat nicht verfügbar.'],
    ...Object.entries(DENIAL_GERMAN).map(([reason, german]) =>
      [deniedText(reason as ToolDenialReason), fromStream, german] as [string, typeof fromStream, string]),
    ...Object.entries(BUDGET_GERMAN).map(([dimension, [limit, german]]) =>
      [budgetText([[dimension as BudgetReason, limit]]), fromStream, german] as [string, typeof fromStream, string]),
    [budgetText([['totalTimeoutMs', 500]]), fromStream, 'Zeitlimit für diesen Durchlauf erreicht (500 ms).'],
    [budgetText([['maxToolCalls', 8], ['maxConsecutiveErrors', 3]]), fromStream,
      'Limit für Tool-Aufrufe in diesem Durchlauf erreicht (8). Limit für aufeinanderfolgende Tool-Fehler erreicht (3).'],
    [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_not_found, fromStream,
      'Nicht gefunden oder für dich nicht sichtbar. Es wurde nichts ausgeführt.'],
    [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_invalid_id, fromStream, 'Keine gültige ID. Es wurde nichts ausgeführt.'],
    [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_unavailable, fromStream,
      'Konnte gerade nicht geprüft werden. Es wurde nichts ausgeführt.'],
    [ENDPOINT_PATH_NOT_RELATIVE_ERROR, fromOutput('tasks_create', 400), 'Der Endpunktpfad muss relativ zur API sein'],
    [ENDPOINT_PATH_NOT_ALLOWED_ERROR, fromOutput('tasks_create', 403), 'Der Endpunktpfad ist nicht erlaubt'],
    [await endpointError(statusOnly(503)), fromOutput('tasks_create', 503), 'Endpunkt fehlgeschlagen (503)'],
    [await endpointError(neverAnswers, { timeoutMs: 5 }), fromOutput(), 'Fehler in tasks_create: Zeitüberschreitung beim Endpunkt'],
    [await endpointError(bigBody, { maxResponseBytes: 10 }), fromOutput(),
      'Fehler in tasks_create: Die Antwort des Endpunkts überschreitet maxResponseBytes'],
    ...memoryTexts().map(([tool, text, german]) => [text, fromOutput(tool), german] as [string, ReturnType<typeof fromOutput>, string]),
  ];
}

describe('readStepFailures', () => {
  it('recognizes every fixed failure text the SDK writes where it writes it, English exactly as before, German as expected', async () => {
    for (const [text, where, german] of await sdkTexts()) {
      const failures = readStepFailures(text, where);
      expect(failures, text).toBeDefined();
      expect(stepFailureText(failures!, DEFAULT_LOCALE, 'en'), text).toBe(text);
      expect(stepFailureText(failures!, deChatLocale, 'de'), text).toBe(german);
    }
  });

  it('reads the timeout of the real endpoint caller', async () => {
    const text = await endpointError(neverAnswers, { timeoutMs: 5 });
    expect(text).toBe('Error in tasks_create: Endpoint timed out');
    expect(readStepFailures(text, fromOutput())).toEqual([{ code: 'endpoint-timeout', values: { tool: 'tasks_create' } }]);
  });

  it('reads the values of a text with values', () => {
    expect(readStepFailures('Endpoint failed (404)', fromOutput('tasks_create', 404)))
      .toEqual([{ code: 'endpoint-failed', values: { status: '404' } }]);
    expect(readStepFailures(budgetText([['totalTimeoutMs', 90_000]]), fromStream))
      .toEqual([{ code: 'limit-time', values: { limit: '90 s' } }]);
  });

  it('takes each text only from the channel and tool the SDK writes it through', async () => {
    // A server chat text never arrives as a tool's own output.
    expect(readStepFailures(INVALID_TOOL_INPUT_TEXT, fromOutput())).toBeUndefined();
    expect(readStepFailures(deniedText('principal_role_denied'), fromOutput())).toBeUndefined();
    expect(readStepFailures(budgetText([['maxToolCalls', 8]]), fromOutput())).toBeUndefined();
    expect(readStepFailures(GENERIC_STREAM_ERROR_TEXT, fromOutput())).toBeUndefined();
    // The endpoint caller and the memory tools write into the output, never into errorText.
    expect(readStepFailures('Endpoint failed (503)', { source: 'error-text', toolName: 'tasks_create' })).toBeUndefined();
    expect(readStepFailures('The note could not be saved.', { source: 'error-text', toolName: MEMORY_REMEMBER_TOOL_NAME })).toBeUndefined();
    // A memory text only from the memory tool that writes it, not from an app tool.
    expect(readStepFailures('The note could not be saved.', fromOutput('notes_save'))).toBeUndefined();
    expect(readStepFailures('The note could not be saved.', fromOutput(MEMORY_FORGET_TOOL_NAME))).toBeUndefined();
    // The thrown-error form names the step's own tool.
    expect(readStepFailures('Error in other_tool: Endpoint timed out', fromOutput('tasks_create'))).toBeUndefined();
    // The status the text names is the result's.
    expect(readStepFailures('Endpoint failed (503)', fromOutput('tasks_create', 500))).toBeUndefined();
  });

  it('takes a value only in the form the server writes it', () => {
    expect(readStepFailures('Endpoint failed (foo) bar (503)', fromOutput())).toBeUndefined();
    expect(readStepFailures('Endpoint failed (5030)', fromOutput())).toBeUndefined();
    expect(readStepFailures('Tool call limit for this turn reached (many).', fromStream)).toBeUndefined();
    expect(readStepFailures('Time limit for this turn reached (soon).', fromStream)).toBeUndefined();
    expect(readStepFailures('Memory is full (lots of notes). Remove a note that is no longer needed first.',
      fromOutput(MEMORY_REMEMBER_TOOL_NAME))).toBeUndefined();
  });

  it('leaves a text the SDK did not write alone: backend or tool content, a text from a newer server', () => {
    for (const text of [
      'Aufgabe ist gesperrt',
      'Error in tasks_create: Task is locked',
      'Endpoint failed',
      'Tool call limit for this turn reached (8). And something else.',
      'A brand-new failure text from a newer server.',
      '',
    ]) {
      expect(readStepFailures(text, fromStream), text).toBeUndefined();
      expect(readStepFailures(text, fromOutput()), text).toBeUndefined();
    }
  });
});

describe('stepFailureText', () => {
  it('has a text for every code in every built-in language', () => {
    for (const code of STEP_FAILURE_CODES) {
      const failure: StepFailure = { code, values: { status: '500', tool: 'x', limit: '3', max: '20' } };
      expect(stepFailureText([failure], DEFAULT_LOCALE, 'en'), code).not.toBe('');
      expect(stepFailureText([failure], deChatLocale, 'de'), code).not.toBe(stepFailureText([failure], DEFAULT_LOCALE, 'en'));
    }
  });

  it('formats a plain number in the chat language and keeps its unit; English stays as the server wrote it', () => {
    const cost: StepFailure[] = [{ code: 'limit-cost', values: { limit: '0.0123' } }];
    const time: StepFailure[] = [{ code: 'limit-time', values: { limit: '1.5 s' } }];
    const tokens: StepFailure[] = [{ code: 'limit-input-tokens', values: { limit: '40000' } }];
    expect(stepFailureText(cost, deChatLocale, 'de')).toBe('Kostenlimit für diesen Durchlauf erreicht (0,0123 USD).');
    expect(stepFailureText(time, deChatLocale, 'de-AT')).toBe('Zeitlimit für diesen Durchlauf erreicht (1,5 s).');
    expect(stepFailureText(tokens, deChatLocale, 'de')).toBe('Limit für Eingabe-Tokens in diesem Durchlauf erreicht (40000).');
    expect(stepFailureText(cost, DEFAULT_LOCALE, 'en')).toBe('Cost limit for this turn reached (0.0123 USD).');
    expect(stepFailureText(time, DEFAULT_LOCALE, 'en-US')).toBe('Time limit for this turn reached (1.5 s).');
    expect(stepFailureText(tokens, DEFAULT_LOCALE, 'en')).toBe('Input token limit for this turn reached (40000).');
    // The English built-in text keeps the server's number also in another chat language.
    expect(stepFailureText(cost, DEFAULT_LOCALE, 'de')).toBe('Cost limit for this turn reached (0.0123 USD).');
    // An app's own text of another language gets that language's number.
    expect(stepFailureText(cost, { activityFailureLimitCost: 'Limit kosztów ({limit} USD).' }, 'pl')).toBe('Limit kosztów (0,0123 USD).');
    // A status and a tool name are no numbers to format.
    expect(stepFailureText([{ code: 'endpoint-failed', values: { status: '503' } }], deChatLocale, 'de'))
      .toBe('Endpunkt fehlgeschlagen (503)');
  });

  it('shows the generic failure text for a code it does not know', () => {
    const unknown = [{ code: 'quota-frozen' } as unknown as StepFailure];
    expect(stepFailureText(unknown, DEFAULT_LOCALE, 'en')).toBe('AI request failed');
    expect(stepFailureText(unknown, deChatLocale, 'de')).toBe('KI-Anfrage fehlgeschlagen');
  });

  it("takes the app's own text of a key, and English for a key a partial locale lacks", () => {
    const failures = readStepFailures('Endpoint failed (500)', fromOutput('tasks_create', 500))!;
    expect(stepFailureText(failures, { ...deChatLocale, activityFailureEndpointFailed: 'Server antwortet nicht ({status})' }, 'de'))
      .toBe('Server antwortet nicht (500)');
    expect(stepFailureText(failures, {}, 'de')).toBe('Endpoint failed (500)');
  });
});
