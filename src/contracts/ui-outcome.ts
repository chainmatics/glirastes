/**
 * Outcome protocol of UI actions, version 1: what the browser learned about
 * a UI action the server handed to it. The browser classifies every
 * dispatched action into one of these codes; later protocol stages report it
 * back with the tool result (`outcome: { v: 1, code }`). Content-free: a code
 * and a client-side timestamp, never the action payload.
 *
 * A new code is a new protocol version. A reader of version 1 treats an
 * unknown version or code, and an outcome without code, as "not confirmed".
 */
import { z } from 'zod';

/** Highest outcome protocol version this package speaks. */
export const UI_OUTCOME_PROTOCOL_VERSION = 1 as const;

/**
 * `ok` the app carried it out; `rejected-contract` the payload did not match
 * the app's contract; `rejected-handler` the handler declined it (returned
 * `false`); `unavailable` nothing on the open page handles it; `failed` the
 * handler threw; `initiated` a full page load was started for it.
 */
export const UI_OUTCOME_CODES = [
  'ok',
  'rejected-contract',
  'rejected-handler',
  'unavailable',
  'failed',
  'initiated',
] as const;

export type UiOutcomeCode = (typeof UI_OUTCOME_CODES)[number];

export const UiOutcomeCodeSchema = z.enum(UI_OUTCOME_CODES);

/**
 * `outcome` of a UI tool result. Without `code` the action is not confirmed
 * (timeout, a bus of an older SDK copy). `at` is the browser's epoch time in
 * milliseconds, read only by the browser; the server ignores it.
 */
export const UiOutcomeSchema = z.object({
  v: z.literal(UI_OUTCOME_PROTOCOL_VERSION),
  code: UiOutcomeCodeSchema.optional(),
  at: z.number().int().nonnegative().optional(),
}).strict();

export type UiOutcome = z.infer<typeof UiOutcomeSchema>;

export function isUiOutcomeCode(value: unknown): value is UiOutcomeCode {
  return typeof value === 'string' && (UI_OUTCOME_CODES as readonly string[]).includes(value);
}
