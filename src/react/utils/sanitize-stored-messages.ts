function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  return messages
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
