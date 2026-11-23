import type { Tool } from '../../types.js';
import { applyOutputBound, type OutputBound } from './output-fields.js';
import { boundedToolFailure } from './tool-failure-result.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the model gets for a successful result whose details may not be shown. */
/**
 * The `uiAction` of a withheld result under an output bound: the any-depth
 * deny keys are removed as in every other result, and an action that cannot
 * be serialized (so cannot be checked) is left out.
 */
function boundedUiAction(uiAction: unknown, bound: OutputBound | undefined): unknown {
  if (!bound || !uiAction) return uiAction;
  return applyOutputBound({ success: true, uiAction }, bound)?.uiAction;
}

function withheldResult(uiAction: unknown): Record<string, unknown> {
  return {
    success: true,
    outputWithheld: true,
    message: 'The tool ran, but its result did not match its declared output, so the details are withheld. Do not call it again for the same request.',
    ...(uiAction ? { uiAction } : {}),
  };
}
/**
 * The core of a tool result before any size handling: a failure bounded by
 * the tool's output fields, a success parsed by the output schema (extra
 * fields stripped, `success` and `uiAction` kept) or withheld when it does
 * not match, then the output bound (`outputAllowedFields`,
 * `outputDeniedFields`, app-wide denied fields). `successful` is false for a
 * failure and a withheld result. Used by `toolToAiTool` and by the server's
 * approval-subject lookups, so a lookup never sees more than the tool's
 * result would show.
 */
export function cleanToolResult(
  tool: Pick<Tool, 'outputSchema'>,
  result: unknown,
  bound: OutputBound | undefined,
  name: string,
  protectedResult = false,
): { value: unknown; successful: boolean; withheld: boolean } {
  // Output schema: parse to strip extra fields, re-attach uiAction for client
  let cleanResult: unknown = result;
  let withheld = false;
  // A successful result of the declared shape (not a failure, not withheld): output fields apply to it.
  let successful = !(isRecord(result) && result.success === false);
  if (isRecord(result) && result.success === false) {
    cleanResult = boundedToolFailure(result, bound, protectedResult);
  } else if (
    tool.outputSchema &&
    isRecord(result)
  ) {
    const rec = result as Record<string, unknown>;
    let parsed = tool.outputSchema.safeParse(result);
    if (
      !parsed.success
      && rec.uiAction !== undefined
    ) {
      const {
        uiAction: _transportUiAction,
        ...payloadWithoutUiAction
      } = rec;
      parsed = tool.outputSchema.safeParse(payloadWithoutUiAction);
    }
    if (!parsed.success && rec.success !== undefined) {
      const {
        success: _transportSuccess,
        uiAction: _transportUiAction,
        ...declaredPayload
      } = rec;
      parsed = tool.outputSchema.safeParse(declaredPayload);
    }
    const carriedUnderData = !parsed.success
      && rec.data !== undefined
      && (!isRecord(rec.data) || Array.isArray(rec.data));
    if (carriedUnderData) parsed = tool.outputSchema.safeParse(rec.data);
    if (parsed.success) {
      // Use parsed data (extra fields stripped by Zod)
      cleanResult = {
        ...(carriedUnderData ? { data: parsed.data } : parsed.data as Record<string, unknown>),
        // Preserve success flag
        ...(rec.success !== undefined ? { success: rec.success } : {}),
        // Re-attach uiAction for client stream (stripped by schema parse)
        ...(rec.uiAction ? { uiAction: rec.uiAction } : {}),
      };
    } else {
      // Schema mismatch — retain bounded diagnostics locally, but never
      // expose an undeclared backend payload to the model.
      // Validation paths and messages may embed backend data (including
      // object keys and custom validator messages). Keep diagnostics
      // technical; never print those values from a runtime process.
      console.warn(`[glirastes] Output schema mismatch for tool "${name}": ${parsed.error.issues.length} issue(s).`);
      // The tool ran, and a write may already have happened: report it
      // as done, so the model neither claims a failure nor calls again.
      cleanResult = withheldResult(boundedUiAction(rec.uiAction, bound));
      successful = false;
      withheld = true;
    }
  }

  // The upper bound comes first: nothing outside outputAllowedFields, and
  // nothing in outputDeniedFields, reaches the PII shield, the store, the
  // overview, the cut or the browser.
  if (bound && successful) {
    const bounded = applyOutputBound(cleanResult, bound);
    if (bounded) cleanResult = bounded;
    else {
      // Not serializable, so it cannot be bounded: withheld.
      cleanResult = withheldResult(boundedUiAction(isRecord(cleanResult) ? cleanResult.uiAction : undefined, bound));
      successful = false;
      withheld = true;
    }
  }
  return { value: cleanResult, successful, withheld };
}
