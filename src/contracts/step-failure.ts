// ============================================================================
// The kind of a localized stream failure text (`data-step-failure`)
// ============================================================================

/**
 * The UI stream part that names the kind of a failed tool call's
 * `errorText` when the server wrote it in a text the browser cannot
 * recognize by its English wording: the chat's language (`de*`) or the
 * handler's own `locales` texts for the generic failure and invalid tool
 * input. The activity log then shows its own locale text for that kind
 * (`activityFailureGeneric`, `activityFailureInvalidInput`), as it does for
 * the English texts; the `errorText` itself stays the server's.
 * Content-free: the call's id and a fixed code, nothing else.
 */
export const STEP_FAILURE_PART_TYPE = 'data-step-failure';

/** The kinds the part names: the generic failure and invalid tool input. */
export const STEP_FAILURE_PART_CODES = ['failed', 'invalid-input'] as const;
export type StepFailurePartCode = (typeof STEP_FAILURE_PART_CODES)[number];

/** `data` of a `data-step-failure` part. */
export interface StepFailurePartData {
  toolCallId: string;
  code: StepFailurePartCode;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `data` of a `data-step-failure` part when it has the expected shape,
 * else undefined. The part is stored in the client's history, so it is
 * read like any client data.
 */
export function parseStepFailurePart(value: unknown): StepFailurePartData | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.toolCallId !== 'string' || value.toolCallId === '' || value.toolCallId.length > 200) return undefined;
  if (!(STEP_FAILURE_PART_CODES as ReadonlyArray<unknown>).includes(value.code)) return undefined;
  return { toolCallId: value.toolCallId, code: value.code as StepFailurePartCode };
}

/** The code per call id of every `data-step-failure` part among `parts`. */
export function readStepFailurePartCodes(parts: ReadonlyArray<unknown>): Map<string, StepFailurePartCode> {
  const codes = new Map<string, StepFailurePartCode>();
  for (const part of parts) {
    if (!isRecord(part) || part.type !== STEP_FAILURE_PART_TYPE) continue;
    const data = parseStepFailurePart(part.data);
    if (data) codes.set(data.toolCallId, data.code);
  }
  return codes;
}
