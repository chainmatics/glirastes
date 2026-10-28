import '../styles.css';
import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { MessageList } from './message-list.js';
import { ChatInput } from './chat-input.js';
import { MentionInput } from './mention-input.js';
import { SuggestionBar } from './suggestion-bar.js';
import { ApprovalCard as DefaultApprovalCard } from './approval-card.js';
import { BulkApprovalCard as DefaultBulkApprovalCard } from './bulk-approval-card.js';
import { readActivitySteps, readLatestPlan } from '../utils/activity.js';
import type { AiChatPanelProps, PendingApproval } from '../types.js';

/**
 * Batteries-included chat panel.
 *
 * Composes MessageList, ChatInput/MentionInput, SuggestionBar,
 * approval cards, truncation banner, and typing indicator
 * into a complete chat UI.
 *
 * Uses configuration from the parent `<AiChatProvider>`.
 */
export function AiChatPanel({ className, welcomeMessage }: AiChatPanelProps) {
  const {
    classNames,
    hasMentions,
    hasCompletions,
    locale,
    isLoading,
    stop,
    error,
    messages,
    pipelineSteps,
    pipelineState,
    pendingApprovals,
    approvalReminder,
    approve,
    reject,
    isProcessingApproval,
    truncation,
    continueTruncation,
    dismissTruncation,
    components,
    themeVars,
    themeEffect,
    unstyled,
  } = useChatContext();

  const ApprovalCardComponent = components.ApprovalCard ?? DefaultApprovalCard;
  const BulkApprovalCardComponent = components.BulkApprovalCard ?? DefaultBulkApprovalCard;
  // The work log lives in each assistant bubble; a pipeline bar only shows
  // when the app supplies its own component.
  const PipelineTimelineComponent = components.PipelineTimeline;
  const InputComponent = components.ChatInput
    ?? (hasMentions || hasCompletions ? MentionInput : ChatInput);

  // Group approvals by tool name for bulk operations
  const { singleApprovals, bulkGroups } = useMemo(() => {
    const groups = new Map<string, PendingApproval[]>();
    for (const approval of pendingApprovals) {
      const existing = groups.get(approval.toolName) ?? [];
      existing.push(approval);
      groups.set(approval.toolName, existing);
    }

    const singles: PendingApproval[] = [];
    const bulks: PendingApproval[][] = [];
    for (const [, approvals] of groups) {
      if (approvals.length === 1) {
        singles.push(approvals[0]);
      } else {
        bulks.push(approvals);
      }
    }
    return { singleApprovals: singles, bulkGroups: bulks };
  }, [pendingApprovals]);

  // Check if last assistant message has visible text (for typing indicator)
  const showTypingIndicator = useMemo(() => {
    if (!isLoading) return false;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return true;
    // The activity log already shows a spinner for running tools.
    if (
      readActivitySteps(lastAssistant.parts, () => false).length > 0
      || (readLatestPlan(lastAssistant.parts)?.length ?? 0) >= 2
    ) return false;
    const hasText = lastAssistant.parts.some(
      p => 'text' in p && typeof p.text === 'string' && p.text.trim().length > 0,
    );
    return !hasText;
  }, [isLoading, messages]);

  return (
    <div
      className={className ?? classNames.panel}
      data-component="ai-chat-panel"
      data-state={isLoading ? 'loading' : 'idle'}
      data-theme-effect={themeEffect}
      data-unstyled={unstyled || undefined}
      style={themeVars}
    >
      {error && (
        <div data-component="error-banner" role="alert">
          {locale.errorMessage}
        </div>
      )}

      {PipelineTimelineComponent && (
        <PipelineTimelineComponent
          steps={pipelineSteps}
          pipelineState={pipelineState}
          isLoading={isLoading}
          onStop={stop}
        />
      )}

      {messages.length > 0 ? (
        <MessageList />
      ) : welcomeMessage ? (
        <div data-component="message-list">
          <div data-component="message-bubble" data-role="assistant">
            <div data-element="content">{welcomeMessage}</div>
          </div>
        </div>
      ) : (
        <div data-component="empty-state">
          {locale.emptyState}
        </div>
      )}

      {/* Single approval cards (rendered after messages) */}
      {singleApprovals.map((approval) => (
        <ApprovalCardComponent
          key={approval.id}
          approval={approval}
          onApprove={approve}
          onReject={reject}
          isProcessing={isProcessingApproval}
        />
      ))}

      {/* Bulk approval cards (2+ approvals of same tool type) */}
      {bulkGroups.map((group) => (
        <BulkApprovalCardComponent
          key={`bulk-${group[0].toolName}`}
          toolName={group[0].toolName}
          approvals={group}
          onApproveAll={() => {
            for (const a of group) approve(a.id);
          }}
          onRejectAll={() => {
            for (const a of group) reject(a.id);
          }}
          isProcessing={isProcessingApproval}
        />
      ))}

      {approvalReminder && pendingApprovals.length > 0 && (
        <div data-component="approval-reminder" role="status">
          {locale.approvalPendingHint}
        </div>
      )}

      {/* Typing indicator */}
      {showTypingIndicator && (
        <div data-component="typing-indicator">
          <span data-element="dot" />
          <span data-element="dot" />
          <span data-element="dot" />
        </div>
      )}

      {/* Truncation banner */}
      {truncation && !isLoading && (
        <div data-component="truncation-banner">
          <p data-element="message">{truncation.message}</p>
          <div data-element="actions">
            <button onClick={continueTruncation} data-action="continue">
              {locale.continueButton}
            </button>
            <button onClick={dismissTruncation} data-action="dismiss">
              {locale.dismissButton}
            </button>
          </div>
        </div>
      )}

      {!isLoading && !showTypingIndicator && <SuggestionBar />}
      <InputComponent />
    </div>
  );
}
