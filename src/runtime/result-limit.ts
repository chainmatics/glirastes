/**
 * Bounds of `maxResultChars`, the upper bound of a serialized tool result the
 * model sees. Dependency-free, so runtime, runtime service, codegen and the
 * server core share one definition; `glirastes/server` re-exports it.
 */

/** Default max characters of a serialized tool result (~4000 tokens). */
export const DEFAULT_MAX_RESULT_CHARS = 16_000;
/** Smallest accepted `maxResultChars` (global option, per tool, OpenAPI extension). */
export const MIN_MAX_RESULT_CHARS = 1_000;
/** Largest accepted `maxResultChars` (global option, per tool, OpenAPI extension). */
export const MAX_MAX_RESULT_CHARS = 200_000;

/** Whether `value` is an accepted `maxResultChars`: an integer from 1,000 to 200,000. */
export function isValidMaxResultChars(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_MAX_RESULT_CHARS
    && value <= MAX_MAX_RESULT_CHARS;
}

/** Throws a clear error naming `label` when `value` is set but no accepted `maxResultChars`. */
export function assertMaxResultChars(value: unknown, label: string): void {
  if (value === undefined || isValidMaxResultChars(value)) return;
  throw new Error(
    `${label}: maxResultChars must be an integer from ${MIN_MAX_RESULT_CHARS} to ${MAX_MAX_RESULT_CHARS}`,
  );
}
