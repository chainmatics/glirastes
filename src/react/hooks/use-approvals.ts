import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { UseApprovalsReturn, PendingApproval } from '../types.js';

/**
 * Hook for managing tool call approvals.
 *
 * Provides pending approvals, grouped by tool name for bulk operations,
 * and approve/reject actions (single and bulk).
 *
 * @example
 * ```tsx
 * function ApprovalList() {
 *   const { pending, approve, reject, grouped, isProcessing } = useApprovals();
 *
 *   return pending.map(a => (
 *     <div key={a.id}>
 *       <span>{a.toolName}</span>
 *       <button onClick={() => approve(a.id)} disabled={isProcessing}>Approve</button>
 *       <button onClick={() => reject(a.id)} disabled={isProcessing}>Reject</button>
 *     </div>
 *   ));
 * }
 * ```
 */
export function useApprovals(): UseApprovalsReturn {
  const ctx = useChatContext();

  const grouped = useMemo(() => {
    const map = new Map<string, PendingApproval[]>();
    for (const approval of ctx.pendingApprovals) {
      const existing = map.get(approval.toolName) ?? [];
      existing.push(approval);
      map.set(approval.toolName, existing);
    }
    return map;
  }, [ctx.pendingApprovals]);

  const approveGroup = useMemo(
    () => (toolName: string) => {
      const group = grouped.get(toolName);
      if (group) {
        for (const approval of group) {
          ctx.approve(approval.id);
        }
      }
    },
    [grouped, ctx.approve],
  );

  const rejectGroup = useMemo(
    () => (toolName: string) => {
      const group = grouped.get(toolName);
      if (group) {
        for (const approval of group) {
          ctx.reject(approval.id);
        }
      }
    },
    [grouped, ctx.reject],
  );

  return useMemo(
    () => ({
      pending: ctx.pendingApprovals,
      approve: ctx.approve,
      reject: ctx.reject,
      grouped,
      approveGroup,
      rejectGroup,
      isProcessing: ctx.isProcessingApproval,
    }),
    [ctx.pendingApprovals, ctx.approve, ctx.reject, grouped, approveGroup, rejectGroup, ctx.isProcessingApproval],
  );
}
