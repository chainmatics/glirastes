/**
 * The closing text of a turn the handler stopped at a limit: the step cap or
 * a runtime budget, when the model gets no final summary call (or that call
 * fails or says nothing). The handler appends it as its own text part, so it
 * is part of the assistant message the browser keeps and the next turn's
 * model sees. Fixed texts per reason with the limit value only: no usage of
 * other dimensions, no tool data, no principal data.
 */
import type { BudgetReason } from '../../../runtime/budget.js';

/** Why the handler stopped the turn: a runtime budget dimension, or `maxSteps` (the handler's step cap). */
export type BudgetStopReason = BudgetReason | 'maxSteps';

/**
 * The texts of the closing notice, keyed by reason. `closing` is the whole
 * notice after text of the model, `closingWithoutAnswer` the one for a turn
 * that showed no text at all; `{reason}` are the reached limits; each reason text gets the limit as
 * `{limit}` (number formatted for the locale; a duration with its unit).
 */
export type BudgetStopTexts = { closing: string; closingWithoutAnswer: string } & Record<BudgetStopReason, string>;

const EN: BudgetStopTexts = Object.freeze({
  closing: 'I had to stop here: {reason}. The answer above may be incomplete.',
  closingWithoutAnswer: 'I could not finish this request: {reason}.',
  maxSteps: 'the step limit for this request was reached ({limit} steps)',
  maxModelSteps: 'the step limit for this request was reached ({limit} steps)',
  maxToolCalls: 'the limit for this request was reached (tool calls: {limit})',
  totalTimeoutMs: 'the time limit for this request was reached ({limit})',
  maxInputTokens: 'the limit for this request was reached (input tokens: {limit})',
  maxOutputTokens: 'the limit for this request was reached (output tokens: {limit})',
  maxEstimatedCostUsd: 'the cost limit for this request was reached ({limit} USD)',
  maxRepeatedFingerprint: 'the same tool call kept returning the same result (limit: {limit})',
  maxConsecutiveErrors: 'too many tool calls failed in a row (limit: {limit})',
});

const DE: BudgetStopTexts = Object.freeze({
  closing: 'Ich musste hier aufhören: {reason}. Die Antwort oben ist möglicherweise unvollständig.',
  closingWithoutAnswer: 'Ich konnte diese Anfrage nicht abschließen: {reason}.',
  maxSteps: 'das Schrittlimit für diese Anfrage ist erreicht ({limit} Schritte)',
  maxModelSteps: 'das Schrittlimit für diese Anfrage ist erreicht ({limit} Schritte)',
  maxToolCalls: 'das Limit für diese Anfrage ist erreicht (Tool-Aufrufe: {limit})',
  totalTimeoutMs: 'das Zeitlimit für diese Anfrage ist erreicht ({limit})',
  maxInputTokens: 'das Limit für diese Anfrage ist erreicht (Eingabe-Tokens: {limit})',
  maxOutputTokens: 'das Limit für diese Anfrage ist erreicht (Ausgabe-Tokens: {limit})',
  maxEstimatedCostUsd: 'das Kostenlimit für diese Anfrage ist erreicht ({limit} USD)',
  maxRepeatedFingerprint: 'derselbe Tool-Aufruf lieferte immer wieder dasselbe Ergebnis (Limit: {limit})',
  maxConsecutiveErrors: 'zu viele Tool-Aufrufe sind nacheinander fehlgeschlagen (Limit: {limit})',
});

/** The shipped defaults, English and German. */
export const DEFAULT_BUDGET_STOP_TEXTS: Readonly<{ en: BudgetStopTexts; de: BudgetStopTexts }> = Object.freeze({ en: EN, de: DE });

const KEYS: ReadonlySet<string> = new Set(Object.keys(EN));

/**
 * Whether the handler's built-in texts are German for `locale` (`de*`,
 * case-insensitive); every other value, and none, is English. The budget
 * stop notice, the silent-turn answer and the stream failure texts share it.
 */
export function isGermanTextLocale(locale: string | undefined): boolean {
  return locale?.toLowerCase().startsWith('de') ?? false;
}

/**
 * The texts for `locale` (German for `de*`, else English) with `overrides`
 * replacing single keys. Throws for an unknown key or a value that is no
 * non-empty string.
 */
export function resolveBudgetStopTexts(
  locale: string | undefined,
  overrides: Partial<BudgetStopTexts> | undefined,
  label = 'createAiChatHandler',
): BudgetStopTexts {
  const base = isGermanTextLocale(locale) ? DE : EN;
  if (overrides === undefined) return base;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error(`${label}: budgetStopTexts must be an object of texts`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!KEYS.has(key)) throw new Error(`${label}: budgetStopTexts.${key} is not a text key`);
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`${label}: budgetStopTexts.${key} must be a non-empty string`);
    }
  }
  return Object.freeze({ ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) });
}

function formatNumber(value: number, locale: string | undefined): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  } catch {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
  }
}

function formatLimit(reason: BudgetStopReason, limit: number, locale: string | undefined): string {
  if (reason !== 'totalTimeoutMs') return formatNumber(limit, locale);
  return limit < 1000 ? `${formatNumber(Math.round(limit), locale)} ms` : `${formatNumber(Math.round(limit / 100) / 10, locale)} s`;
}

/** One reached limit. */
export interface BudgetStopLimit {
  dimension: BudgetStopReason;
  limit: number;
}

/**
 * Asks `notice` at each part that can end the stream (`finish`, `error`,
 * `abort`) and, when it returns a text, writes it as an own text part right
 * before that part: at most once per stream.
 */
export function withStopNotice<T>(
  source: ReadableStream<T>,
  notice: (terminal: 'finish' | 'error' | 'abort', hadText: boolean) => string | undefined,
): ReadableStream<T> {
  let written = false;
  // Whether the user has seen any text of the model in this answer.
  let hadText = false;
  return source.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      const type = (chunk as { type?: unknown }).type;
      if (type === 'text-delta' && typeof (chunk as { delta?: unknown }).delta === 'string'
        && ((chunk as { delta: string }).delta).trim() !== '') hadText = true;
      if (!written && (type === 'finish' || type === 'error' || type === 'abort')) {
        const text = notice(type, hadText);
        if (text) {
          written = true;
          const id = 'glirastes-stop-notice';
          controller.enqueue({ type: 'text-start', id } as T);
          controller.enqueue({ type: 'text-delta', id, delta: text } as T);
          controller.enqueue({ type: 'text-end', id } as T);
        }
      }
      controller.enqueue(chunk);
    },
  }));
}

/** The closing notice for the reached limits, e.g. "I had to stop here: the limit … (input tokens: 40,000). …". */
export function budgetStopText(
  limits: ReadonlyArray<BudgetStopLimit>,
  texts: BudgetStopTexts,
  locale?: string,
  hadText = true,
): string {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const { dimension, limit } of limits) {
    const reason = texts[dimension].split('{limit}').join(formatLimit(dimension, limit, locale));
    if (seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
  }
  // "The answer above" only makes sense when there is one.
  return (hadText ? texts.closing : texts.closingWithoutAnswer).split('{reason}').join(reasons.join('; '));
}
