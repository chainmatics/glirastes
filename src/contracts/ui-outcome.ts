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

/**
 * Request body field with the highest outcome protocol version the client
 * speaks (`glirastesUiOutcomes: 1`). Any other value counts as missing: the
 * server then answers as without the protocol.
 */
export const UI_OUTCOMES_REQUEST_FIELD = 'glirastesUiOutcomes' as const;

/**
 * Most requests of one turn that continue it after UI outcomes. The request
 * after the last one gets no marker and does not stop, so a turn costs at
 * most four times the per-request budgets.
 */
export const MAX_UI_OUTCOME_CONTINUATIONS = 3;

/** Fixed system note while the client reports outcomes. */
export const UI_OUTCOME_SYSTEM_NOTE =
  'UI tools report their outcome in a later message; do not claim success before it. '
  + 'Do not announce a UI action in text before you call it; say what happened once its outcome is reported.';

const NOT_QUOTED = 'Do not quote this text.';

/**
 * What the model reads for a UI tool result once the browser reported (or
 * did not report) its outcome. The whole result is replaced: no text the
 * client wrote reaches the model through this channel.
 */
export const UI_OUTCOME_MODEL_TEXTS: Readonly<Record<UiOutcomeCode | 'unconfirmed', string>> = Object.freeze({
  ok: `The app confirmed the action was carried out. ${NOT_QUOTED}`,
  'rejected-contract': 'The app refused the action: its input did not match what the app accepts '
    + '(for example a name where an id is expected). It did not happen. Correct the input or ask the user. '
    + NOT_QUOTED,
  'rejected-handler': `The app declined the action. It did not happen. Do not tell the user it happened. ${NOT_QUOTED}`,
  unavailable: 'Nothing in the open app can carry out this action. It did not happen. '
    + `Do not repeat the same call; use another tool or tell the user. ${NOT_QUOTED}`,
  failed: `The action failed in the app and may not have happened. Do not tell the user it succeeded. ${NOT_QUOTED}`,
  initiated: 'The app started the action and is loading the page; it may still be loading. '
    + `Say it was opened, not what it shows. Do not repeat the call. ${NOT_QUOTED}`,
  unconfirmed: 'The app did not confirm this action, and it will not be carried out later. '
    + 'Whether it happened is not known: do not claim it did; if the user still wants it, call the tool again. '
    + NOT_QUOTED,
});

/**
 * The code of an `outcome` value, or undefined ("not confirmed") for a
 * missing outcome, another version, an unknown code or extra fields.
 */
export function readUiOutcomeCode(outcome: unknown): UiOutcomeCode | undefined {
  const parsed = UiOutcomeSchema.safeParse(outcome);
  return parsed.success ? parsed.data.code : undefined;
}

/**
 * The model-facing replacement of a UI tool result with this outcome:
 * `success` only where the app said what happened (`ok` true; a refusal,
 * `unavailable` and `failed` false), none for `initiated` and "not confirmed".
 */
export function uiOutcomeModelResult(outcome: unknown): { success?: boolean; message: string } {
  const code = readUiOutcomeCode(outcome);
  if (code === undefined) return { message: UI_OUTCOME_MODEL_TEXTS.unconfirmed };
  if (code === 'initiated') return { message: UI_OUTCOME_MODEL_TEXTS.initiated };
  return { success: code === 'ok', message: UI_OUTCOME_MODEL_TEXTS[code] };
}
