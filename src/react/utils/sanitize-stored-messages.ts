function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Older streams appended a second assistant snapshot after an approval.
 * Only discard the earlier copy when the adjacent continuation has the same
 * input and a completed result. Conflicting calls remain for server validation.
 * This is storage recovery, never authorization or a server-side bypass.
 */
function recoverContinuationSnapshots(messages: unknown[]): unknown[] {
  return messages.map((message, index) => {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.parts)) return message;
    const following: Record<string, unknown>[] = [];
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next];
      if (!isRecord(candidate) || candidate.role !== 'assistant') break;
      if (Array.isArray(candidate.parts)) following.push(...candidate.parts.filter(isRecord));
    }
    return { ...message, parts: message.parts.filter((part) => {
      if (!isRecord(part) || typeof part.type !== 'string' || !part.type.startsWith('tool-')
        || typeof part.toolCallId !== 'string') return true;
      return !following.some((next) => {
        if (next.type !== part.type || next.toolCallId !== part.toolCallId
          || JSON.stringify(next.input) !== JSON.stringify(part.input)) return false;
        if (part.state === 'output-available') return next.state === 'output-available'
          && JSON.stringify(next.output) === JSON.stringify(part.output);
        if (part.state !== 'approval-responded' || next.state !== 'output-available') return false;
        return isRecord(part.approval) && isRecord(next.approval)
          && part.approval.id === next.approval.id && part.approval.approved === next.approval.approved;
      });
    }) };
  });
}

/**
 * Sanitize raw stored messages to remove incomplete tool calls that would
 * cause `AI_MissingToolResultsError` when sent to the API.
 *
 * This handles the case where a user closes the chat or refreshes while
 * a tool approval is pending, leaving orphaned tool calls in the history.
 *
 * Call this when loading messages from storage (sessionStorage, localStorage,
 * or any backend) before passing them to `setMessages()` or the SDK provider.
 *
 * @example
 * ```ts
 * const sessionAdapter: SessionConfig = {
 *   load: () => {
 *     const raw = JSON.parse(sessionStorage.getItem('chat') ?? '[]');
 *     return sanitizeStoredMessages(raw);
 *   },
 *   save: (_, msgs) => sessionStorage.setItem('chat', JSON.stringify(msgs)),
 *   clear: () => sessionStorage.removeItem('chat'),
 * };
 * ```
 */
export function sanitizeStoredMessages(messages: unknown[]): unknown[] {
  return recoverContinuationSnapshots(messages)
    .map((message) => {
      if (!isRecord(message)) return message;

      const parts = Array.isArray(message.parts) ? message.parts : [];
      const sanitizedParts = parts.filter((part) => {
        if (!isRecord(part)) return true;

        const partType = typeof part.type === 'string' ? part.type : '';

        // Remove tool parts stuck in approval-requested state
        if (partType.startsWith('tool-') && part.state === 'approval-requested') {
          return false;
        }

        return true;
      });

      // If all parts were removed, mark for filtering
      if (sanitizedParts.length === 0 && parts.length > 0) {
        return null;
      }

      return { ...message, parts: sanitizedParts };
    })
    .filter((message) => message !== null);
}
