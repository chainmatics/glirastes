/**
 * Sanitize model messages for OpenAI compatibility.
 *
 * Handles three classes of problems that occur after convertToModelMessages +
 * pruneMessages from the Vercel AI SDK:
 *
 * 1. **Orphaned tool-calls** — assistant has tool-call but no matching
 *    tool-result anywhere (pruneMessages stripped it).
 * 2. **Orphaned tool-approval-requests** — approval request without matching
 *    response, or whose linked tool-call was removed.
 * 3. **Ordering violations** — OpenAI requires tool-result messages to
 *    IMMEDIATELY follow their assistant message. After pruning, the ordering
 *    can break.
 *
 * **Important:** The OpenAI provider silently drops `tool-approval-response`
 * parts during serialization. A tool message containing ONLY approval-responses
 * (no tool-result) produces zero OpenAI messages. Therefore, a tool-call is
 * only considered "safe" when it has an adjacent `tool-result` — a
 * `tool-approval-response` alone does NOT satisfy this requirement.
 *
 * **Exception:** When the LAST message is a tool message containing
 * `tool-approval-response` parts, those tool-calls are preserved. The Vercel
 * AI SDK's `streamText` runs `collectToolApprovals()` on the last message
 * and executes approved tools BEFORE sending anything to OpenAI. Stripping
 * these would break the approval flow (causing an infinite loop where the
 * model re-generates the same tool call).
 *
 * The public API is {@link sanitizeModelMessages}, which runs two passes:
 * - Primary pass: adjacency-based orphan removal
 * - Safety-net pass: strict re-check for any remaining orphans
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Build a mapping from approvalId → toolCallId from assistant messages.
 */
function buildApprovalIdToCallIdMap(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        isRecord(part) &&
        part.type === 'tool-approval-request' &&
        typeof part.approvalId === 'string' &&
        typeof part.toolCallId === 'string'
      ) {
        map.set(part.approvalId as string, part.toolCallId as string);
      }
    }
  }
  return map;
}

/**
 * Find tool-call IDs that have a pending `tool-approval-response` in the
 * LAST tool message. These are safe because `streamText`'s
 * `collectToolApprovals()` will execute them before calling the model.
 */
function findPendingApprovalCallIds(
  messages: unknown[],
  approvalIdToCallId: Map<string, string>,
): Set<string> {
  const pendingCallIds = new Set<string>();

  // collectToolApprovals in streamText only looks at the very last message
  const lastMsg = messages.at(-1);
  if (!isRecord(lastMsg) || lastMsg.role !== 'tool') return pendingCallIds;

  const content = lastMsg.content;
  if (!Array.isArray(content)) return pendingCallIds;

  // Only consider this a pending approval if the tool message has NO
  // tool-result parts (otherwise it's a completed step, not a pending approval)
  const hasToolResult = content.some(
    (part) => isRecord(part) && part.type === 'tool-result',
  );
  if (hasToolResult) return pendingCallIds;

  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === 'tool-approval-response' &&
      typeof part.approvalId === 'string'
    ) {
      const linkedCallId = approvalIdToCallId.get(part.approvalId as string);
      if (linkedCallId) {
        pendingCallIds.add(linkedCallId);
      }
    }
  }

  return pendingCallIds;
}

/**
 * Remove duplicate assistant tool-call occurrences for the same toolCallId.
 *
 * OpenAI requires each assistant `tool-call` to be followed by tool results
 * for that call in the immediate next tool message block. If the same
 * `toolCallId` appears in multiple assistant messages, one historical copy
 * becomes orphaned and triggers a 400 error.
 *
 * Strategy:
 * - Keep only the LAST assistant occurrence of each toolCallId.
 * - **Exception:** Preserve tool-calls with pending approval-responses at the
 *   conversation tail, as these will be executed by streamText before the
 *   model call.
 * - Remove matching `tool-approval-request` parts from older occurrences.
 * - Drop assistant messages that become empty.
 */
function dedupeAssistantToolCalls<T>(messages: T[]): T[] {
  // Build approval mapping and find pending approvals
  const approvalIdToCallId = buildApprovalIdToCallIdMap(messages);
  const pendingApprovalCallIds = findPendingApprovalCallIds(
    messages,
    approvalIdToCallId,
  );

  const lastAssistantIndexByCallId = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (
        isRecord(part) &&
        part.type === 'tool-call' &&
        typeof part.toolCallId === 'string'
      ) {
        lastAssistantIndexByCallId.set(part.toolCallId, i);
      }
    }
  }

  return messages
    .map((message, messageIndex) => {
      if (!isRecord(message) || message.role !== 'assistant') return message;
      const content = message.content;
      if (!Array.isArray(content)) return message;

      const seenCallIdsInMessage = new Set<string>();
      const filtered = content.filter((part) => {
        if (!isRecord(part)) return true;

        if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
          const isLastOccurrence =
            lastAssistantIndexByCallId.get(part.toolCallId) === messageIndex;
          const isDuplicateInSameMessage = seenCallIdsInMessage.has(
            part.toolCallId,
          );
          const hasPendingApproval = pendingApprovalCallIds.has(
            part.toolCallId,
          );

          // Preserve if: last occurrence, OR has pending approval
          // (pending approval means streamText will execute it - must not remove)
          if (
            (!isLastOccurrence && !hasPendingApproval) ||
            isDuplicateInSameMessage
          ) {
            console.info(
              `[glirastes] Removing duplicate assistant tool call: ${part.toolCallId}`,
            );
            return false;
          }

          seenCallIdsInMessage.add(part.toolCallId);
          return true;
        }

        if (
          part.type === 'tool-approval-request' &&
          typeof part.toolCallId === 'string'
        ) {
          const isLastOccurrence =
            lastAssistantIndexByCallId.get(part.toolCallId) === messageIndex;
          const hasPendingApproval = pendingApprovalCallIds.has(
            part.toolCallId,
          );
          // Keep approval-request if it's for the last occurrence OR has pending approval
          return isLastOccurrence || hasPendingApproval;
        }

        return true;
      });

      if (filtered.length !== content.length) {
        return { ...message, content: filtered } as T;
      }

      return message;
    })
    .filter((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return true;
      const content = message.content;
      return Array.isArray(content) ? content.length > 0 : true;
    });
}

// ---------------------------------------------------------------------------
// Primary pass — removeOrphanedToolCalls
// ---------------------------------------------------------------------------

/**
 * Remove orphaned tool-calls whose results are not immediately adjacent.
 *
 * Strategy:
 *  - For each assistant message with tool-calls, check that the NEXT message(s)
 *    are tool messages containing all required results.
 *  - If not, strip the orphaned tool-call (and any related approval-request).
 *  - Exception: tool-calls with pending approval-responses at the conversation
 *    tail are preserved (streamText will execute them).
 *  - Remove empty assistant/tool messages.
 */
function removeOrphanedToolCalls<T>(messages: T[]): T[] {
  // --- Build approval mapping and find pending approvals ---
  const approvalIdToCallId = buildApprovalIdToCallIdMap(messages);
  const pendingApprovalCallIds = findPendingApprovalCallIds(
    messages,
    approvalIdToCallId,
  );

  // --- Collect all tool-result IDs in tool-role messages ---
  const adjacentResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    const callIds = new Set<string>();
    for (const part of content) {
      if (
        isRecord(part) &&
        part.type === 'tool-call' &&
        typeof part.toolCallId === 'string'
      ) {
        callIds.add(part.toolCallId);
      }
    }
    if (callIds.size === 0) continue;

    // Walk forward: only consecutive tool messages count
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (!isRecord(next) || next.role !== 'tool') break;
      const nextContent = next.content;
      if (!Array.isArray(nextContent)) break;
      for (const part of nextContent) {
        if (
          isRecord(part) &&
          part.type === 'tool-result' &&
          typeof part.toolCallId === 'string'
        ) {
          if (callIds.has(part.toolCallId)) {
            adjacentResultIds.add(part.toolCallId);
          }
        }
      }
    }
  }

  // A tool-call is safe if it has an adjacent result OR a pending approval
  const safeCallIds = new Set([
    ...adjacentResultIds,
    ...pendingApprovalCallIds,
  ]);

  // --- Filter assistant content ---
  return (
    messages
      .map((message) => {
        if (!isRecord(message) || message.role !== 'assistant') return message;
        const content = message.content;
        if (!Array.isArray(content)) return message;

        const filteredContent = content.filter((part) => {
          if (!isRecord(part)) return true;

          // Remove orphaned tool-calls (no adjacent tool-result and no pending approval)
          if (
            part.type === 'tool-call' &&
            typeof part.toolCallId === 'string'
          ) {
            const isSafe = safeCallIds.has(part.toolCallId);
            if (!isSafe) {
              console.info(
                `[glirastes] Removing orphaned tool call: ${part.toolCallId}`,
              );
            }
            return isSafe;
          }

          // Remove approval-requests whose tool-call was removed
          if (
            part.type === 'tool-approval-request' &&
            typeof part.toolCallId === 'string'
          ) {
            return safeCallIds.has(part.toolCallId);
          }

          return true;
        });

        if (filteredContent.length !== content.length) {
          return { ...message, content: filteredContent };
        }
        return message;
      })
      // Remove empty assistant messages
      .filter((message) => {
        if (!isRecord(message) || message.role !== 'assistant') return true;
        const content = message.content;
        if (!Array.isArray(content)) return true;
        return content.length > 0;
      })
      // Remove tool messages whose parts are all orphaned
      .map((message) => {
        if (!isRecord(message) || message.role !== 'tool') return message;
        const content = message.content;
        if (!Array.isArray(content)) return message;
        const filtered = content.filter((part) => {
          if (!isRecord(part)) return true;
          if (
            part.type === 'tool-result' &&
            typeof part.toolCallId === 'string'
          ) {
            return adjacentResultIds.has(part.toolCallId);
          }
          // Approval-responses survive if their linked tool-call survived
          if (
            part.type === 'tool-approval-response' &&
            typeof part.approvalId === 'string'
          ) {
            const linkedCallId = approvalIdToCallId.get(
              part.approvalId as string,
            );
            return linkedCallId ? safeCallIds.has(linkedCallId) : true;
          }
          return true;
        });
        if (filtered.length !== content.length) {
          return { ...message, content: filtered };
        }
        return message;
      })
      .filter((message) => {
        if (!isRecord(message) || message.role !== 'tool') return true;
        const content = message.content;
        if (!Array.isArray(content)) return true;
        // Keep tool message if it has at least one surviving tool-result
        // OR a pending approval-response for a surviving tool-call
        return content.some((part) => {
          if (!isRecord(part)) return false;
          if (
            part.type === 'tool-result' &&
            typeof part.toolCallId === 'string'
          ) {
            return adjacentResultIds.has(part.toolCallId);
          }
          if (
            part.type === 'tool-approval-response' &&
            typeof part.approvalId === 'string'
          ) {
            const linkedCallId = approvalIdToCallId.get(
              part.approvalId as string,
            );
            return linkedCallId
              ? pendingApprovalCallIds.has(linkedCallId)
              : false;
          }
          return false;
        });
      })
  );
}

// ---------------------------------------------------------------------------
// Safety-net pass — stripRemainingOrphanedToolCalls
// ---------------------------------------------------------------------------

/**
 * Strict re-check: strip any tool-call that still lacks an adjacent
 * tool-result after the primary pass.
 *
 * Catches edge cases from pruneMessages / convertToModelMessages that the
 * adjacency-based pass may miss (e.g. step-start block splits, incomplete
 * tool states producing calls without results).
 *
 * Preserves tool-calls with pending approval-responses at the tail.
 */
function stripRemainingOrphanedToolCalls<T>(messages: T[]): T[] {
  // Build approval mapping and find pending approvals
  const approvalIdToCallId = buildApprovalIdToCallIdMap(messages);
  const pendingApprovalCallIds = findPendingApprovalCallIds(
    messages,
    approvalIdToCallId,
  );

  // Build set of "safe" tool-call IDs (have adjacent tool-result OR pending approval)
  const safeCallIds = new Set<string>(pendingApprovalCallIds);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    const callIds = new Set<string>();
    for (const part of content) {
      if (
        isRecord(part) &&
        part.type === 'tool-call' &&
        typeof part.toolCallId === 'string'
      ) {
        callIds.add(part.toolCallId);
      }
    }
    if (callIds.size === 0) continue;

    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (!isRecord(next) || next.role !== 'tool') break;
      const nextContent = next.content;
      if (!Array.isArray(nextContent)) break;
      for (const part of nextContent) {
        if (
          isRecord(part) &&
          part.type === 'tool-result' &&
          typeof part.toolCallId === 'string'
        ) {
          if (callIds.has(part.toolCallId)) {
            safeCallIds.add(part.toolCallId);
          }
        }
      }
    }
  }

  // Strip unsafe tool-calls
  let changed = false;
  let result: T[] = messages
    .map((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return message;
      const content = message.content;
      if (!Array.isArray(content)) return message;

      const filtered = content.filter((part) => {
        if (!isRecord(part)) return true;
        if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
          const safe = safeCallIds.has(part.toolCallId);
          if (!safe) {
            console.warn(
              `[glirastes] Safety-net removing orphaned tool call: ${part.toolCallId}`,
            );
            changed = true;
          }
          return safe;
        }
        if (
          part.type === 'tool-approval-request' &&
          typeof part.toolCallId === 'string'
        ) {
          return safeCallIds.has(part.toolCallId);
        }
        return true;
      });
      if (filtered.length !== content.length)
        return { ...message, content: filtered } as T;
      return message;
    })
    .filter((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return true;
      const content = message.content;
      return Array.isArray(content) ? content.length > 0 : true;
    });

  // Remove tool messages whose results reference no surviving call
  if (changed) {
    result = result.filter((message) => {
      if (!isRecord(message) || message.role !== 'tool') return true;
      const content = message.content;
      if (!Array.isArray(content)) return true;
      return content.some((part) => {
        if (!isRecord(part)) return false;
        if (
          part.type === 'tool-result' &&
          typeof part.toolCallId === 'string'
        ) {
          return safeCallIds.has(part.toolCallId);
        }
        // Keep approval-response if its linked call is a pending approval
        if (
          part.type === 'tool-approval-response' &&
          typeof part.approvalId === 'string'
        ) {
          const linkedCallId = approvalIdToCallId.get(
            part.approvalId as string,
          );
          return linkedCallId
            ? pendingApprovalCallIds.has(linkedCallId)
            : false;
        }
        return true;
      });
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize model messages by removing orphaned tool-calls and
 * tool-approval-requests.
 *
 * A tool-call is considered orphaned when it does not have an adjacent
 * `tool-result` in the immediately following tool message(s). A
 * `tool-approval-response` alone does NOT count — the OpenAI provider
 * silently drops these during serialization.
 *
 * **Exception:** Tool-calls with a `tool-approval-response` in the LAST
 * message are preserved. The Vercel AI SDK's `streamText` runs
 * `collectToolApprovals()` to execute approved tools before calling the
 * model provider, so these are safe to keep.
 *
 * Call this on the output of `pruneMessages()` (from the `ai` SDK) before
 * passing messages to `streamText()`. Or use {@link prepareModelMessages}
 * which calls this automatically.
 *
 * @example
 * ```ts
 * import { sanitizeModelMessages } from './index.js';
 *
 * const raw = await convertToModelMessages(uiMessages, {
 *   ignoreIncompleteToolCalls: true,
 * });
 * const pruned = pruneMessages({ messages: raw.slice(-12), ... });
 * const clean = sanitizeModelMessages(pruned);
 * // clean is safe to pass to streamText()
 * ```
 */
export function sanitizeModelMessages<T>(messages: T[]): T[] {
  const deduped = dedupeAssistantToolCalls(messages);
  const afterPrimary = removeOrphanedToolCalls(deduped);
  return stripRemainingOrphanedToolCalls(afterPrimary);
}
