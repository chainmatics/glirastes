import type { ChatLocale } from '../types.js';
import { fillTemplate } from './fill-template.js';
import { MEMORY_FORGET_TOOL_NAME, MEMORY_REMEMBER_TOOL_NAME } from '../../contracts/memory.js';

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
 * - `assistant-halted`: the environment control halted the assistant.
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
  'assistant-halted',
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
  'assistant-halted': 'activityFailureAssistantHalted',
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
  activityFailureAssistantHalted: 'The assistant is halted.',
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

/** Where a step's text came from: the tool's own result (`output`) or the `errorText` of an `output-error` part. */
export type StepFailureSource = 'output' | 'error-text';

/** What the recognizer knows about the step besides its text. */
export interface StepFailureContext {
  source: StepFailureSource;
  /** The model-facing tool name of the step. */
  toolName: string;
  /** The `status` of the tool's result, when it has a numeric one. */
  status?: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Numbers as the server writes them (`formatNumber`: no grouping, up to four decimals).
const NUMBER = '\\d+(?:\\.\\d+)?';
// Durations as the server writes them (`formatDuration`: `500 ms`, `1.5 s`).
const DURATION = `\\d+ ms|${NUMBER} s`;

/**
 * Where the SDK writes each code's text, and the form of its values. The
 * server masks every tool error of the stream to its chat texts, which reach
 * the browser only as `errorText`; the endpoint caller and the memory tools
 * write into the tool's result. `{tool}` is the step's own tool.
 */
const CHANNELS: Readonly<Record<StepFailureCode, { source: StepFailureSource; tools?: ReadonlyArray<string>; values?: Readonly<Record<string, string>> }>> = {
  failed: { source: 'error-text' },
  'invalid-input': { source: 'error-text' },
  'tool-unavailable': { source: 'error-text' },
  'not-permitted': { source: 'error-text' },
  'identity-missing': { source: 'error-text' },
  'account-refused': { source: 'error-text' },
  'tool-disabled': { source: 'error-text' },
  refused: { source: 'error-text' },
  'assistant-halted': { source: 'error-text' },
  'limit-reached': { source: 'error-text' },
  'limit-tool-calls': { source: 'error-text', values: { limit: NUMBER } },
  'limit-model-steps': { source: 'error-text', values: { limit: NUMBER } },
  'limit-time': { source: 'error-text', values: { limit: DURATION } },
  'limit-input-tokens': { source: 'error-text', values: { limit: NUMBER } },
  'limit-output-tokens': { source: 'error-text', values: { limit: NUMBER } },
  'limit-cost': { source: 'error-text', values: { limit: NUMBER } },
  'limit-repeated-calls': { source: 'error-text', values: { limit: NUMBER } },
  'limit-consecutive-errors': { source: 'error-text', values: { limit: NUMBER } },
  'record-not-found': { source: 'error-text' },
  'record-invalid-id': { source: 'error-text' },
  'record-unchecked': { source: 'error-text' },
  'endpoint-failed': { source: 'output', values: { status: '\\d{3}' } },
  'endpoint-path-not-relative': { source: 'output' },
  'endpoint-path-not-allowed': { source: 'output' },
  'endpoint-timeout': { source: 'output' },
  'endpoint-response-too-large': { source: 'output' },
  'memory-kind-unavailable': { source: 'output', tools: [MEMORY_REMEMBER_TOOL_NAME] },
  'memory-full': { source: 'output', tools: [MEMORY_REMEMBER_TOOL_NAME], values: { max: '\\d+' } },
  'memory-save-failed': { source: 'output', tools: [MEMORY_REMEMBER_TOOL_NAME] },
  'memory-note-mismatch': { source: 'output', tools: [MEMORY_FORGET_TOOL_NAME] },
  'memory-remove-failed': { source: 'output', tools: [MEMORY_FORGET_TOOL_NAME] },
  'memory-note-not-found': { source: 'output', tools: [MEMORY_FORGET_TOOL_NAME] },
};

const LIMIT_CODES: ReadonlyArray<StepFailureCode> = STEP_FAILURE_CODES.filter((code) => code.startsWith('limit-') && code !== 'limit-reached');

/** The pattern of a code's English text: each `{name}` in the form the SDK writes it, `{tool}` the step's tool. */
function patternOf(code: StepFailureCode, toolName: string, tail: string): { regex: RegExp; names: string[] } {
  const forms = CHANNELS[code].values ?? {};
  const names: string[] = [];
  const source = STEP_FAILURE_TEXTS_EN[KEYS[code]].split(/(\{\w+\})/).map((piece) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (!name) return escape(piece);
    names.push(name);
    return `(${name === 'tool' ? escape(toolName) : forms[name] ?? '(?!)'})`;
  }).join('');
  return { regex: new RegExp(`^${source}${tail}`), names };
}

function matchOne(code: StepFailureCode, context: StepFailureContext, text: string, tail: string): { failure: StepFailure; length: number } | undefined {
  const channel = CHANNELS[code];
  if (channel.source !== context.source) return undefined;
  if (channel.tools && !channel.tools.includes(context.toolName)) return undefined;
  const { regex, names } = patternOf(code, context.toolName, tail);
  const match = regex.exec(text);
  if (!match) return undefined;
  const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]!]));
  // The status the text names is the result's own.
  if (code === 'endpoint-failed' && context.status !== undefined && Number(values.status) !== context.status) return undefined;
  return { failure: names.length > 0 ? { code, values } : { code }, length: match[0].length };
}

/**
 * The failures of a step's text when the SDK wrote it (see
 * `STEP_FAILURE_CODES`), else undefined: a text of the app's backend or
 * tool, or one this version does not know (a newer server), stays as it is.
 * A text counts only where the SDK writes it (`context.source`, the memory
 * tools by name, `{tool}` the step's own tool) and with its values in the
 * form the SDK writes them. More than one only for a budget denial that
 * names several limits. An app backend that answers an endpoint tool with
 * the endpoint caller's own wording (`Endpoint failed (503)`) cannot be told
 * apart from it.
 */
export function readStepFailures(text: string, context: StepFailureContext): StepFailure[] | undefined {
  for (const code of STEP_FAILURE_CODES) {
    if (LIMIT_CODES.includes(code)) continue;
    const hit = matchOne(code, context, text, '$');
    if (hit) return [hit.failure];
  }
  const failures: StepFailure[] = [];
  let rest = text;
  while (rest !== '') {
    const hit = LIMIT_CODES.map((code) => matchOne(code, context, rest, '(?: |$)')).find(Boolean);
    if (!hit) return undefined;
    failures.push(hit.failure);
    rest = rest.slice(hit.length);
  }
  return failures.length > 0 ? failures : undefined;
}

// A plain number, optionally with the unit the server writes after it.
const PLAIN_NUMBER = /^(\d+(?:\.\d+)?)((?: (?:ms|s))?)$/;
const NUMBER_VALUES: ReadonlySet<string> = new Set(['limit', 'max']);

/** `limit` and `max` in the number format of `language`, unit kept; anything else as it is. */
function localizedValues(values: Readonly<Record<string, string>>, language: string | undefined): Record<string, string> {
  if (!language) return { ...values };
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 20 });
  } catch {
    return { ...values };
  }
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const match = NUMBER_VALUES.has(name) ? PLAIN_NUMBER.exec(value) : null;
    return [name, match ? `${format.format(Number(match[1]))}${match[2]}` : value];
  }));
}

/**
 * The text of a step's failures in the chat's locale: per failure the
 * locale's key (`activityFailure…`), else the English built-in; a code this
 * version does not know gets the generic text (`activityFailureGeneric`).
 * A plain-number `{limit}` or `{max}` is written in the number format of
 * `language` (the chat's), its unit kept, except in the English built-in
 * text, which keeps the server's form.
 * Several failures are joined by a space, as the server joins them.
 */
export function stepFailureText(failures: ReadonlyArray<StepFailure>, locale: Partial<ChatLocale>, language?: string): string {
  return failures.map((failure) => {
    const key: StepFailureLocaleKey = Object.prototype.hasOwnProperty.call(KEYS, failure.code)
      ? KEYS[failure.code]
      : 'activityFailureGeneric';
    const template = locale[key] ?? STEP_FAILURE_TEXTS_EN[key];
    // The English built-in text keeps the numbers exactly as the server wrote them.
    const values = template === STEP_FAILURE_TEXTS_EN[key] ? failure.values ?? {} : localizedValues(failure.values ?? {}, language);
    return fillTemplate(template, values);
  }).join(' ');
}
