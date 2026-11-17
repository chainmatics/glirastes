import type { UIMessageChunk } from 'ai';
import { isPrivacyError } from './detection-result.js';
import type { AttachmentPolicySnapshot } from './attachment-policy.js';
import { screenshotStatusText } from './attachment-policy.js';
import { historyWithheldNotice } from './history-binding.js';
import type { PrivacySession } from './strict-shield.js';

/** Content-free status the UI shows before and during a protected turn. */
export interface PrivacyStatusData {
  profile: string;
  text: 'protected';
  screenshots: AttachmentPolicySnapshot['screenshots'];
  /** E.g. "Text geschützt; Screenshots werden im Original übertragen". */
  label: string;
  /** Display label of the selected provider/model, never an endpoint or key. */
  provider?: string;
  /**
   * Earlier messages the model no longer receives in this turn (their privacy
   * mapping expired or they are not bound); the chat still shows them.
   */
  historyWithheld?: number;
  /** Notice for the user when `historyWithheld` is set. */
  historyNotice?: string;
}

export function privacyStatusData(
  session: PrivacySession,
  attachments: AttachmentPolicySnapshot,
  options: { locale?: string; providerLabel?: string; historyWithheld?: number } = {},
): PrivacyStatusData {
  return {
    profile: session.profile,
    text: 'protected',
    screenshots: attachments.screenshots,
    label: screenshotStatusText(attachments, options.locale),
    ...(options.providerLabel ? { provider: options.providerLabel } : {}),
    ...(options.historyWithheld
      ? { historyWithheld: options.historyWithheld, historyNotice: historyWithheldNotice(options.locale) }
      : {}),
  };
}

/**
 * The display projection of a protected turn. The model and the server-side
 * history keep pseudonyms; only this stream, rendered for the principal of
 * the session's scope, carries the originals back.
 *
 * Text and reasoning are buffered per part and released at their end, so a
 * pseudonym split across chunks is rehydrated as a whole and an output that
 * fails the leak check is never shown in part. Partial tool input deltas are
 * dropped; the complete input follows with `tool-input-available`.
 */
export function projectUiMessageStream<T extends { type: string }>(
  stream: ReadableStream<T>,
  session: PrivacySession,
  options: { status?: PrivacyStatusData } = {},
): ReadableStream<T> {
  const buffers = new Map<string, string>();
  let statusSent = false;
  return stream.pipeThrough(new TransformStream<T, T>({
    transform(raw, controller) {
      const chunk = raw as unknown as UIMessageChunk;
      if (!statusSent && options.status) {
        statusSent = true;
        controller.enqueue({ type: 'data-privacy-status', data: options.status, transient: true } as unknown as T);
      }
      switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
          buffers.set(chunk.id, (buffers.get(chunk.id) ?? '') + chunk.delta);
          return;
        case 'text-end':
        case 'reasoning-end': {
          const text = buffers.get(chunk.id);
          buffers.delete(chunk.id);
          if (text) {
            controller.enqueue({
              type: chunk.type === 'text-end' ? 'text-delta' : 'reasoning-delta',
              id: chunk.id,
              delta: session.rehydrateText(text),
            } as unknown as T);
          }
          controller.enqueue(raw);
          return;
        }
        case 'tool-input-delta':
          return;
        case 'tool-input-available':
        case 'tool-input-error':
          controller.enqueue({ ...chunk, input: session.rehydrateJson(chunk.input) } as unknown as T);
          return;
        case 'error':
          buffers.clear();
          controller.enqueue({ ...chunk, errorText: safeErrorText(chunk.errorText) } as unknown as T);
          return;
        default:
          controller.enqueue(raw);
      }
    },
    flush() {
      // Unfinished text parts were never checked; they are not released.
      buffers.clear();
    },
  }));
}

const PRIVACY_CODE = /^(privacy_[a-z_]+|provider_[a-z_]+)$/;

function safeErrorText(text: string): string {
  return PRIVACY_CODE.test(text) ? text : 'AI request failed';
}

/** Error text for a UI stream in the protected profile: a privacy code or a generic text. */
export function privacyStreamErrorText(error: unknown): string {
  return isPrivacyError(error) ? error.code : 'AI request failed';
}
