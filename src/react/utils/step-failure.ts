import type { ChatLocale } from '../types.js';
import { fillTemplate } from './fill-template.js';

/**
 * The kinds of step failure the SDK itself writes a fixed text for: the
 * server's chat texts of a refused or failed call (`errorText` of an
 * `output-error` part) and the fixed `error` texts of the endpoint caller
 * and the memory tools. Each has a locale key (`activityFailure…`); a text
 * written by the app's backend or tool has no kind and is shown as it is.
 * - `failed`: the call failed for a reason the server does not name (generic).
 * - `invalid-input`: the model's arguments did not match the tool's schema.
 * - `tool-unavailable`, `not-permitted`, `identity-missing`, `account-refused`,
 *   `tool-disabled`, `refused`: the managed turn guard refused the call.
 * - `limit-reached` and `limit-*`: the turn's budget refused it (`{limit}`).
 * - `record-not-found`, `record-invalid-id`, `record-unchecked`: the server
 *   refused the call before its approval card (approval subjects).
 * - `endpoint-failed` (`{status}`), `endpoint-path-not-relative`,
 *   `endpoint-path-not-allowed`, `endpoint-timeout` and
 *   `endpoint-response-too-large` (`{tool}`): the endpoint caller.
 * - `memory-*`: the built-in memory tools (`memory_remember`, `memory_forget`).
 */
export const STEP_FAILURE_CODES = [
  'failed',
  'invalid-input',
  'tool-unavailable',
  'not-permitted',
  'identity-missing',
  'account-refused',
  'tool-disabled',
  'refused',
  'limit-reached',
  'limit-tool-calls',
  'limit-model-steps',
  'limit-time',
  'limit-input-tokens',
  'limit-output-tokens',
  'limit-cost',
  'limit-repeated-calls',
  'limit-consecutive-errors',
  'record-not-found',
  'record-invalid-id',
  'record-unchecked',
  'endpoint-failed',
  'endpoint-path-not-relative',
  'endpoint-path-not-allowed',
  'endpoint-timeout',
  'endpoint-response-too-large',
  'memory-kind-unavailable',
  'memory-full',
  'memory-save-failed',
  'memory-note-mismatch',
  'memory-remove-failed',
  'memory-note-not-found',
] as const;

export type StepFailureCode = (typeof STEP_FAILURE_CODES)[number];

/** One failure the SDK wrote for a step, with the values of its text (`status`, `tool`, `limit`, `max`). */
export interface StepFailure {
  code: StepFailureCode;
  values?: Readonly<Record<string, string>>;
}

/** The locale key of each code. */
export type StepFailureLocaleKey = `activityFailure${string}` & keyof ChatLocale;

const KEYS: Readonly<Record<StepFailureCode, StepFailureLocaleKey>> = {
  failed: 'activityFailureGeneric',
  'invalid-input': 'activityFailureInvalidInput',
  'tool-unavailable': 'activityFailureToolUnavailable',
  'not-permitted': 'activityFailureNotPermitted',
  'identity-missing': 'activityFailureIdentityMissing',
  'account-refused': 'activityFailureAccountRefused',
  'tool-disabled': 'activityFailureToolDisabled',
  refused: 'activityFailureRefused',
  'limit-reached': 'activityFailureLimitReached',
  'limit-tool-calls': 'activityFailureLimitToolCalls',
  'limit-model-steps': 'activityFailureLimitModelSteps',
  'limit-time': 'activityFailureLimitTime',
  'limit-input-tokens': 'activityFailureLimitInputTokens',
  'limit-output-tokens': 'activityFailureLimitOutputTokens',
  'limit-cost': 'activityFailureLimitCost',
  'limit-repeated-calls': 'activityFailureLimitRepeatedCalls',
  'limit-consecutive-errors': 'activityFailureLimitConsecutiveErrors',
  'record-not-found': 'activityFailureRecordNotFound',
  'record-invalid-id': 'activityFailureRecordInvalidId',
  'record-unchecked': 'activityFailureRecordUnchecked',
  'endpoint-failed': 'activityFailureEndpointFailed',
  'endpoint-path-not-relative': 'activityFailureEndpointPathNotRelative',
  'endpoint-path-not-allowed': 'activityFailureEndpointPathNotAllowed',
  'endpoint-timeout': 'activityFailureEndpointTimeout',
  'endpoint-response-too-large': 'activityFailureEndpointResponseTooLarge',
  'memory-kind-unavailable': 'activityFailureMemoryKindUnavailable',
  'memory-full': 'activityFailureMemoryFull',
  'memory-save-failed': 'activityFailureMemorySaveFailed',
  'memory-note-mismatch': 'activityFailureMemoryNoteMismatch',
  'memory-remove-failed': 'activityFailureMemoryRemoveFailed',
  'memory-note-not-found': 'activityFailureMemoryNoteNotFound',
};

/**
 * The English texts, word for word what the server and the tools write: the
 * default locale's texts and the patterns a step's text is recognized by.
 */
export const STEP_FAILURE_TEXTS_EN: Readonly<Record<StepFailureLocaleKey, string>> = {
  activityFailureGeneric: 'AI request failed',
  activityFailureInvalidInput: 'The assistant sent invalid input for this tool; it was told what to correct.',
  activityFailureToolUnavailable: 'This tool is not available in this chat.',
  activityFailureNotPermitted: 'You are not permitted to use this tool.',
  activityFailureIdentityMissing: 'The user could not be identified; tool call refused.',
  activityFailureAccountRefused: 'Tool call refused for this account.',
  activityFailureToolDisabled: 'This tool has been disabled.',
  activityFailureRefused: 'Tool call refused.',
  activityFailureLimitReached: 'Limit for this turn reached.',
  activityFailureLimitToolCalls: 'Tool call limit for this turn reached ({limit}).',
  activityFailureLimitModelSteps: 'Step limit for this turn reached ({limit}).',
  activityFailureLimitTime: 'Time limit for this turn reached ({limit}).',
  activityFailureLimitInputTokens: 'Input token limit for this turn reached ({limit}).',
  activityFailureLimitOutputTokens: 'Output token limit for this turn reached ({limit}).',
  activityFailureLimitCost: 'Cost limit for this turn reached ({limit} USD).',
  activityFailureLimitRepeatedCalls: 'Limit for repeated identical tool calls reached ({limit}).',
  activityFailureLimitConsecutiveErrors: 'Limit for consecutive tool errors reached ({limit}).',
  activityFailureRecordNotFound: 'Not found, or not visible to you. Nothing was done.',
  activityFailureRecordInvalidId: 'Not a valid id. Nothing was done.',
  activityFailureRecordUnchecked: 'Could not be checked right now. Nothing was done.',
  activityFailureEndpointFailed: 'Endpoint failed ({status})',
  activityFailureEndpointPathNotRelative: 'Endpoint path must be relative to the API',
  activityFailureEndpointPathNotAllowed: 'Endpoint path is not allowed',
  activityFailureEndpointTimeout: 'Error in {tool}: Endpoint timed out',
  activityFailureEndpointResponseTooLarge: 'Error in {tool}: Endpoint response exceeds maxResponseBytes',
  activityFailureMemoryKindUnavailable: 'This kind of memory is not available.',
  activityFailureMemoryFull: 'Memory is full ({max} notes). Remove a note that is no longer needed first.',
  activityFailureMemorySaveFailed: 'The note could not be saved.',
  activityFailureMemoryNoteMismatch: 'The note text does not match this id. Pass the note exactly as shown in the memory block.',
  activityFailureMemoryRemoveFailed: 'The note could not be removed.',
  activityFailureMemoryNoteNotFound: 'No note with this id.',
};

interface Pattern {
  code: StepFailureCode;
  regex: RegExp;
  names: string[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern from an English template: each `{name}` one non-empty value. */
function patternOf(code: StepFailureCode, tail: string): Pattern {
  const template = STEP_FAILURE_TEXTS_EN[KEYS[code]];
  const names: string[] = [];
  const source = template.split(/(\{\w+\})/).map((piece) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (!name) return escape(piece);
    names.push(name);
    return '(.+?)';
  }).join('');
  return { code, regex: new RegExp(`^${source}${tail}`), names };
}

const LIMIT_CODES: ReadonlyArray<StepFailureCode> = STEP_FAILURE_CODES.filter((code) => code.startsWith('limit-') && code !== 'limit-reached');
// The budget denial names each exhausted limit in one sentence, the sentences joined by a space.
const LIMIT_PATTERNS = LIMIT_CODES.map((code) => patternOf(code, '(?: |$)'));
const WHOLE_PATTERNS = STEP_FAILURE_CODES.filter((code) => !LIMIT_CODES.includes(code)).map((code) => patternOf(code, '$'));

function matchOne(pattern: Pattern, text: string): { failure: StepFailure; length: number } | undefined {
  const match = pattern.regex.exec(text);
  if (!match) return undefined;
  const values = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]!]));
  return { failure: pattern.names.length > 0 ? { code: pattern.code, values } : { code: pattern.code }, length: match[0].length };
}

/**
 * The failures of a step's text when the SDK wrote it (see
 * `STEP_FAILURE_CODES`), else undefined: a text of the app's backend or
 * tool, or one this version does not know (a newer server), stays as it is.
 * More than one only for a budget denial that names several limits.
 */
export function readStepFailures(text: string): StepFailure[] | undefined {
  for (const pattern of WHOLE_PATTERNS) {
    const hit = matchOne(pattern, text);
    if (hit) return [hit.failure];
  }
  const failures: StepFailure[] = [];
  let rest = text;
  while (rest !== '') {
    const hit = LIMIT_PATTERNS.map((pattern) => matchOne(pattern, rest)).find(Boolean);
    if (!hit) return undefined;
    failures.push(hit.failure);
    rest = rest.slice(hit.length);
  }
  return failures.length > 0 ? failures : undefined;
}

/**
 * The text of a step's failures in the chat's locale: per failure the
 * locale's key (`activityFailure…`), else the English built-in; a code this
 * version does not know gets the generic text (`activityFailureGeneric`).
 * Several failures are joined by a space, as the server joins them.
 */
export function stepFailureText(failures: ReadonlyArray<StepFailure>, locale: Partial<ChatLocale>): string {
  return failures.map((failure) => {
    const key: StepFailureLocaleKey = Object.prototype.hasOwnProperty.call(KEYS, failure.code)
      ? KEYS[failure.code]
      : 'activityFailureGeneric';
    const template = locale[key] ?? STEP_FAILURE_TEXTS_EN[key];
    return fillTemplate(template, failure.values ?? {});
  }).join(' ');
}
