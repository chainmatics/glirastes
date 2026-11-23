import type { ApprovalDenialCode, DeniedApproval } from './approval-binding.js';

/**
 * What the model reads for a tool call that did not run because of its
 * approval. The AI SDK hands the model `approval.reason` of the tool part as
 * the call's result (`execution-denied` / `error-text`, "Tool execution
 * denied." without one). That reason is client-written for a refusal (the
 * browser sends any text it likes) and a bare code for a server denial, so
 * the model guessed a failure and its cause. Every reason is therefore
 * replaced by a fixed server text before the history becomes model messages;
 * nothing the client wrote reaches the model through it.
 */

/** The user pressed "Cancel" (or any client answer with `approved: false`). */
export const APPROVAL_DECLINED_TEXT =
  'The user declined this action in the approval dialog, so it was not executed. '
  + 'This is not an error: do not retry it and do not guess a cause. '
  + 'Acknowledge it briefly and ask the user what they want to do instead.';

const CONFIRM_AGAIN = 'If the user still wants it, call the tool again so they can confirm it again.';

/** One sentence per server denial code of `enforceApprovalBindings`. */
export const APPROVAL_DENIAL_TEXTS: Readonly<Record<ApprovalDenialCode, string>> = {
  approval_expired: `This action was not executed: its approval expired before it could run. Do not guess another cause. ${CONFIRM_AGAIN}`,
  approval_already_used: 'This action was not executed: its approval had already been used once. Do not guess another cause. '
    + 'If the user wants it to happen again, call the tool again so they can confirm it again.',
  approval_not_issued: `This action was not executed: its approval could not be verified. Do not guess a cause. ${CONFIRM_AGAIN}`,
  approval_not_runnable: `This action was not executed: its approval could not be used in this request. Do not guess a cause. ${CONFIRM_AGAIN}`,
  approval_store_unavailable: 'This action was not executed: its approval could not be checked right now. Do not guess a cause. '
    + 'Tell the user it was not carried out and that they can ask for it again later.',
  approval_subject_gone: 'This action was not executed: the record it was approved for no longer exists or is no longer visible. '
    + 'Do not retry it and do not guess another cause. Do not quote this text.',
  approval_subject_changed: 'This action was not executed: the record it was approved for has changed since the approval. '
    + `Do not guess another cause. ${CONFIRM_AGAIN} Do not quote this text.`,
  approval_subject_unavailable: 'This action was not executed: the record it was approved for could not be checked again right now. '
    + 'Do not guess a cause. Tell the user it was not carried out and that they can ask for it again later. Do not quote this text.',
};

/**
 * A call the user approved that the server did not run in an earlier request:
 * the browser keeps `approved: true` on the part when the stream says
 * `tool-output-denied`, and the code of that request is gone.
 */
export const APPROVAL_NOT_USED_TEXT =
  `This action was not executed: its approval could not be used. Do not guess a cause. ${CONFIRM_AGAIN}`;

type MessageRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is MessageRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const isToolPart = (part: MessageRecord): boolean =>
  typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');

/**
 * The history with the model-facing reason of every refused or denied
 * approval set by the server, after `enforceApprovalBindings`:
 *
 * - a part this request denied (`denied`): the text of its code;
 * - any other part answered `approved: false`: `APPROVAL_DECLINED_TEXT`;
 * - an `output-denied` part answered `approved: true` (denied in an earlier
 *   request): `APPROVAL_NOT_USED_TEXT`.
 *
 * Only `approval.reason` changes: approval ids, answers, states and inputs
 * stay as `enforceApprovalBindings` left them, so nothing it verified or
 * consumed is affected.
 */
export function withModelFacingDenialReasons(
  messages: ReadonlyArray<unknown>,
  denied: ReadonlyArray<DeniedApproval>,
): unknown[] {
  const codes = new Map(denied.map((entry) => [entry.toolCallId, entry.code] as const));
  return messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isRecord(part) || !isToolPart(part) || !isRecord(part.approval)) return part;
      const reason = reasonFor(part, codes);
      if (reason === undefined || part.approval.reason === reason) return part;
      changed = true;
      return { ...part, approval: { ...part.approval, reason } };
    });
    return changed ? { ...message, parts } : message;
  });
}

function reasonFor(part: MessageRecord, codes: ReadonlyMap<string, ApprovalDenialCode>): string | undefined {
  const approval = part.approval as MessageRecord;
  const code = typeof part.toolCallId === 'string' ? codes.get(part.toolCallId) : undefined;
  if (code !== undefined && approval.approved === false) return APPROVAL_DENIAL_TEXTS[code];
  if (approval.approved === false) return APPROVAL_DECLINED_TEXT;
  if (part.state === 'output-denied') return APPROVAL_NOT_USED_TEXT;
  return undefined;
}
