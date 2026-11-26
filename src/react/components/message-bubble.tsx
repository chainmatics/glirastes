import { Fragment, Suspense, lazy, useCallback, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { MentionChip as DefaultMentionChip } from './mention-chip.js';
import { useChatMarkdownOptions } from '../markdown-options.js';
import { unescapeMarkerLabels } from '../entity-links/marker-text.js';
import { markdownLoadingLimit, markdownModuleForLazy, markdownOverdue, markdownTimedOut, subscribeMarkdownTimeout } from '../markdown-module.js';
import { loadingMarkdownSources } from '../utils/copy-message.js';
import { readStepFailurePartCodes } from '../../contracts/step-failure.js';
import { useMessageChat, useOptionalMessageChat } from '../provider/message-chat-context.js';
import { parseMentionSegments, stripContextBlocks } from '../utils/mention-markup.js';
import {
  EntityText,
  MentionMarkers,
  markdownWithMentionMarkers,
  useChatEntityLinks,
  WithoutEntityLinks,
} from '../entity-links/entity-links-react.js';
import { ApprovalCard as DefaultApprovalCard } from './approval-card.js';
import { ApprovalEntry as DefaultApprovalEntry } from './approval-entry.js';
import { fillTemplate } from '../utils/fill-template.js';
import { readToolPartApproval } from '../utils/tool-part-approval.js';
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { clarificationAnswerMessage, readClarificationPart } from '../utils/clarification.js';
import { ClarificationCard as DefaultClarificationCard } from './clarification-card.js';
import { ActivityLog, TurnNotice as DefaultTurnNotice } from './activity-log.js';
import { PlanChecklist } from './plan-checklist.js';
import { MessageFooter } from './message-footer.js';
import { readActivitySteps, readLatestPlan, withoutHiddenTools, type ActivityDetailSource, type ActivityStep, type ActivityStepStatus } from '../utils/activity.js';
import { PLAN_TOOL_NAME } from '../../contracts/plan.js';
import { RendererBoundary } from '../tool-renderers/renderer-boundary.js';
import { ChatView, readChatViewPart } from '../chat-views/chat-view.js';
import { RENDER_VIEW_TOOL_NAME } from '../../contracts/chat-view.js';
import {
  CLARIFICATION_TOOL_NAME,
  stripClarificationMarkers,
} from '../../contracts/clarification.js';
import { stripChatCommandMarkers } from '../../contracts/chat-command.js';
import { isUiActionHandoffMessage } from '../../browser/ui-action-handoff.js';
import { endsWithContinuableBudgetStop, readBudgetStopPart } from '../../contracts/budget-continuation.js';
import type {
  ActivityLogDetails,
  ChatLocale,
  ChatMessage,
  FilePart,
  MessageBubbleProps,
  MessagePartEntry,
  MessagePartKind,
  MessageParts,
  PipelineState,
  TextPart,
  ToolPartApproval,
  TurnNoticeStatus,
  TurnOutcome,
} from '../types.js';
import { turnStartId } from '../utils/turn-outcomes.js';

// Lazy-load react-markdown over the shared import (`preloadMarkdown`).
type ReactMarkdownOptions = import('react-markdown').Options;

const ReactMarkdown = lazy(markdownModuleForLazy);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shouldRenderToolResult(
  toolName: string,
  mode: 'default' | 'hidden' | 'allowlist',
  allowlist: string[],
): boolean {
  // Follow-up registration is consumed by the suggestion system, not exposed
  // as a raw tool result in either supported message-part format.
  if (toolName === 'suggest_followups') return false;
  // Clarifications render as an answerable card, never as raw output.
  if (toolName === CLARIFICATION_TOOL_NAME) return false;
  // The plan renders as a checklist.
  if (toolName === PLAN_TOOL_NAME) return false;
  // A chat view renders as the view (or its text), never as raw output.
  if (toolName === RENDER_VIEW_TOOL_NAME) return false;
  if (mode === 'hidden') return false;
  if (mode === 'allowlist') return allowlist.includes(toolName);
  return true;
}

/**
 * Whether a step's detail (error text, done message) is shown under the
 * `activityLog.details` policy. `resultShown`: the tool's result is displayed
 * (`toolResults`). Under `'auto'` the error text a tool returned for a failed
 * or neutral step is shown whatever the result display; the `errorText` the
 * AI SDK or the runtime wrote (`source: 'error-text'`) only where results are.
 */
function allowStepDetail(
  details: ActivityLogDetails,
  status: ActivityStepStatus,
  source: ActivityDetailSource,
  resultShown: boolean,
): boolean {
  switch (details) {
    case 'none':
      return false;
    case 'all':
      return true;
    case 'results':
      return resultShown;
    default:
      return resultShown || (source === 'output' && (status === 'error' || status === 'expected'));
  }
}

function isToolPart(part: unknown): boolean {
  if (!isRecord(part) || typeof part.type !== 'string') return false;
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

type ActivitySection =
  | { kind: 'text'; node: ReactNode }
  | { kind: 'steps'; steps: ActivityStep[]; start: number };

/**
 * The text nodes and the runs of tool steps of a message in message order,
 * or null when no run of steps comes after a text (the single log renders
 * exactly as before then). Parts that are neither (reasoning, step markers,
 * data) do not split a run.
 */
function activitySections(
  parts: ReadonlyArray<unknown>,
  texts: ReadonlyArray<{ index: number; node: ReactNode }>,
  readSteps: (parts: ReadonlyArray<unknown>) => ActivityStep[],
): ActivitySection[] | null {
  const textAt = new Map(texts.map((entry) => [entry.index, entry.node] as const));
  const raw: Array<{ kind: 'text'; node: ReactNode } | { kind: 'tools'; parts: unknown[]; start: number }> = [];
  parts.forEach((part, index) => {
    const node = textAt.get(index);
    if (node !== undefined && node !== null) {
      raw.push({ kind: 'text', node });
      return;
    }
    if (!isToolPart(part)) return;
    const last = raw.at(-1);
    if (last?.kind === 'tools') last.parts.push(part);
    else raw.push({ kind: 'tools', parts: [part], start: index });
  });
  const sections: ActivitySection[] = [];
  for (const entry of raw) {
    if (entry.kind === 'text') {
      sections.push(entry);
      continue;
    }
    const steps = readSteps(entry.parts);
    if (steps.length > 0) sections.push({ kind: 'steps', steps, start: entry.start });
  }
  const firstText = sections.findIndex((section) => section.kind === 'text');
  const interleaved = firstText >= 0 && sections.slice(firstText).some((section) => section.kind === 'steps');
  return interleaved ? sections : null;
}

/** Stop or failure of the latest turn, shown as the last activity line. */
function pipelineNotice(
  state: PipelineState | null,
  locale: ChatLocale,
): { text: string; status: TurnNoticeStatus } | undefined {
  return statusNotice(state?.status, locale);
}

/** Locale text of a turn notice status. */
export function statusNotice(
  status: string | undefined,
  locale: ChatLocale,
): { text: string; status: TurnNoticeStatus } | undefined {
  switch (status) {
    case 'safety-stop':
      return { text: locale.pipelineSafetyStopLabel, status: 'safety-stop' };
    case 'aborted':
      return { text: locale.pipelineAbortedLabel, status: 'aborted' };
    case 'error':
      return { text: locale.pipelineErrorLabel, status: 'error' };
    default:
      return undefined;
  }
}

/** Model-facing tool name of a tool part (`tool-{name}`, `dynamic-tool`, a `tool-result`), else null. */
function toolPartName(part: Record<string, unknown>): string | null {
  const type = typeof part.type === 'string' ? part.type : '';
  if (type === 'dynamic-tool' || type === 'tool-result') return typeof part.toolName === 'string' ? part.toolName : null;
  if (type.startsWith('tool-') && type !== 'tool-call') return type.slice('tool-'.length);
  return typeof part.toolName === 'string' && 'result' in part ? part.toolName : null;
}

function partKind(part: unknown): MessagePartKind {
  if (isTextPart(part)) return 'text';
  if (isFilePart(part)) return 'file';
  return isRecord(part) && toolPartName(part) !== null ? 'tool' : 'other';
}

/** The text without its last paragraph (after the last blank line); a text of one paragraph stays. */
function withoutLastParagraph(text: string): string {
  const trimmed = text.trimEnd();
  let cut = -1;
  for (const match of trimmed.matchAll(/\n[ \t]*\n/g)) cut = match.index;
  return cut > 0 ? trimmed.slice(0, cut) : text;
}

function isTextPart(part: unknown): part is TextPart {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

function isFilePart(part: unknown): part is FilePart {
  return isRecord(part) && part.type === 'file' && typeof part.url === 'string' && typeof part.mediaType === 'string';
}

function isSafeHref(url: string): boolean {
  return /^(data:|https?:|blob:)/i.test(url);
}

// Browsers refuse top-level navigation to data: URLs, so open a blob copy instead.
function openDataUrl(url: string): boolean {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match || typeof URL.createObjectURL !== 'function') return false;
  const [, mediaType, base64, payload] = match;
  let bytes: Uint8Array;
  try {
    bytes = base64
      ? Uint8Array.from(atob(payload!), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload!));
  } catch {
    return false;
  }
  const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType || 'application/octet-stream' }));
  window.open(blobUrl, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  return true;
}

function MessageAttachment({ part, locale }: { part: FilePart; locale: ChatLocale }) {
  const name = part.filename ?? part.mediaType;
  if (!part.url) {
    return (
      <span data-element="message-attachment" data-kind="file" data-state="unavailable">
        <span data-element="file-name">{name}</span>
        <span data-element="attachment-note">{locale.attachmentUnavailableLabel}</span>
      </span>
    );
  }
  const isImage = part.mediaType.startsWith('image/');
  if (!isImage || !isSafeHref(part.url)) {
    return (
      <span data-element="message-attachment" data-kind="file">
        <span data-element="file-name">{name}</span>
      </span>
    );
  }
  const label = fillTemplate(locale.openAttachmentLabel, { name });
  return (
    <a
      href={part.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-element="message-attachment"
      data-kind="image"
      onClick={(event) => {
        if (part.url.startsWith('data:') && openDataUrl(part.url)) event.preventDefault();
      }}
    >
      <img src={part.url} alt={name} data-element="thumbnail" />
    </a>
  );
}

/**
 * The rendered parts of one message (plan, activity log, turn notice,
 * attachments, text, tool results), each `null` when absent, for a custom
 * `MessageBubble` or `components.MessageParts` that arranges them itself.
 */
export function useMessageParts(message: ChatMessage): MessageParts {
  const { logsAt: _logsAt, ...parts } = useMessagePartsWithLogs(message);
  return parts;
}

/**
 * `useMessageParts` plus, with `activityLog.grouping: 'sections'`, each
 * section's log keyed by the index of the first tool part of its run, so the
 * bubble can keep the logs when it renders the parts in message order.
 */
function useMessagePartsWithLogs(message: ChatMessage): MessageParts & { logsAt: ReadonlyMap<number, ReactNode> } {
  const {
    components,
    toolResults,
    toolRendererRegistry,
    chatViewRegistry,
    runChatViewAction,
    messages,
    send,
    isLoading,
    locale,
    pipelineState,
    activityLog,
    pendingApprovals,
    approve,
    reject,
    isProcessingApproval,
    isApprovalResendPending,
    approvalDescription,
    approvalSubjects,
    approvalDisplay,
    entityDeclarations,
    language,
    turnOutcomes,
    mentionPrefix,
    composer,
    messageFooter,
    suggestions,
    isTurnRunning,
    continueAfterBudgetStop,
  } = useMessageChat();
  const ApprovalCardComponent = components.ApprovalCard ?? DefaultApprovalCard;
  const ApprovalEntryComponent = components.ApprovalEntry ?? DefaultApprovalEntry;
  const MarkdownComponent = components.Markdown ?? DefaultMarkdown;
  const ToolResultComponent = components.ToolResultBlock ?? DefaultToolResult;
  const MentionChipComponent = components.MentionChip ?? DefaultMentionChip;
  const ClarificationComponent = components.ClarificationCard ?? DefaultClarificationCard;
  const TurnNoticeComponent = components.TurnNotice ?? DefaultTurnNotice;
  const links = useChatEntityLinks();
  const linkText = links.enabled && message.role === 'assistant';
  // `entityLinks.scope: 'assistant'`: nothing in a user's message becomes a chip, wherever its parts are placed.
  const linksOff = links.enabled && links.scope === 'assistant' && message.role !== 'assistant';
  const scoped = (node: ReactNode): ReactNode => (linksOff && node !== null ? <WithoutEntityLinks>{node}</WithoutEntityLinks> : node);
  const isLatestMessage = messages?.[messages.length - 1]?.id === message.id;

  const renderToolResult = (key: string, toolName: string, result: unknown) => {
    const fallback = <ToolResultComponent key={key} toolName={toolName} result={result} />;
    const resolved = toolRendererRegistry?.resolve(toolName, result);
    if (!resolved) return fallback;
    const Renderer = resolved.renderer.component;
    return (
      <RendererBoundary
        key={`${key}@${resolved.renderer.schemaVersion}`}
        fallback={<ToolResultComponent toolName={toolName} result={result} />}
      >
        <div
          data-component="tool-result"
          data-tool={toolName}
          data-renderer={resolved.renderer.definitionId}
          data-schema-version={resolved.renderer.schemaVersion}
        >
          <Renderer
            definitionId={resolved.renderer.definitionId}
            toolName={toolName}
            schemaVersion={resolved.renderer.schemaVersion}
            output={resolved.output}
          />
        </div>
      </RendererBoundary>
    );
  };

  const mode = toolResults.mode ?? 'default';
  const allowlist = toolResults.allowlist ?? [];

  const isAssistant = message.role === 'assistant';
  const details = activityLog?.details ?? 'auto';
  const resultShown = (toolName: string) => shouldRenderToolResult(toolName, mode, allowlist);
  // The server's named kinds of its failure texts, from the whole message: a run of steps has no data parts.
  const stepFailureCodes = readStepFailurePartCodes(message.parts);
  const hiddenTools = activityLog?.hiddenTools ?? [];
  const readSteps = (parts: ReadonlyArray<unknown>): ActivityStep[] => withoutHiddenTools(readActivitySteps(
    parts,
    (toolName, status, source) => allowStepDetail(details, status, source, resultShown(toolName)),
    stepFailureCodes,
  ), hiddenTools).map((step) => (
    // A call the user approved that the server did not run: the reason is the SDK's own text.
    step.status === 'declined' && step.declinedBy === 'server' && !step.detail
      && (details === 'all' || details === 'auto')
      ? { ...step, detail: locale.activityApprovalNotUsedDetail }
      : step
  ));
  const activitySteps = isAssistant ? readSteps(message.parts) : [];
  const planItems = isAssistant ? readLatestPlan(message.parts) : null;
  const hasPlan = (planItems?.length ?? 0) >= 2;
  const turnActive = isLatestMessage && isLoading;
  const turnId = turnOutcomes && turnOutcomes.size > 0 ? turnStartId(messages ?? [message], message.id) : null;
  const turnOutcome: TurnOutcome | null = (turnId ? turnOutcomes?.get(turnId) : undefined) ?? null;
  // `noticeScope: 'every'` (default): an earlier turn shows its recorded outcome, the latest one too once its
  // pipeline state is gone (a reload). `'latest'`: only the latest turn's pipeline state, as before 0.20.0.
  const storedNotice = (activityLog?.noticeScope ?? 'every') === 'every' && turnOutcome && !turnActive
    ? statusNotice(turnOutcome.status, locale)
    : undefined;
  // Only an assistant message carries the notice in the bubble (a turn without one: `MessageList`).
  const notice = isAssistant
    ? (isLatestMessage ? pipelineNotice(pipelineState, locale) ?? storedNotice : storedNotice)
    : undefined;
  const noticeOutcome = notice && turnOutcome ? { outcome: turnOutcome } : {};
  const logNoticeOutcome = notice && turnOutcome ? { noticeOutcome: turnOutcome } : {};
  // Inside the log by default; outside it on request, and always when there is no log to hold it.
  const noticeInLog = notice !== undefined
    && (activityLog?.noticePlacement ?? 'log') === 'log'
    && activitySteps.length > 0;

  // The stop notice of a continuable budget stop ends with how to go on
  // (`continueHint`, "use the button below"). Once the stop was continued or
  // the user wrote on, the button is gone and that last paragraph goes too.
  // A chat without the button keeps it: such an app sets its own text.
  const stopStillOpen = message.role === 'assistant' && isLatestMessage && endsWithContinuableBudgetStop(message);
  let lastStopIndex = message.parts.length - 1;
  while (lastStopIndex >= 0 && !readBudgetStopPart(message.parts[lastStopIndex])) lastStopIndex -= 1;
  const withoutStaleContinueHint = (text: string, index: number): string => {
    if (!readBudgetStopPart(message.parts[index - 1])?.continuable) return text;
    if (stopStillOpen && index - 1 === lastStopIndex) return text;
    return withoutLastParagraph(text);
  };

  // Extract tool result summaries as fallback text when no text parts exist
  const textEntries = message.parts
    .map((part, index) => ({ part, index }))
    .filter((entry): entry is { part: TextPart; index: number } => isTextPart(entry.part))
    .filter((entry) => entry.part.text.trim())
    .map(({ part, index }) => {
      const text = stripChatCommandMarkers(stripClarificationMarkers(stripContextBlocks(withoutStaleContinueHint(part.text, index))));
      return { index, text: message.role === 'assistant' ? extractTrailingFollowupSuggestions(text).text : text };
    });
  const cleanTextParts = textEntries.map((entry) => entry.text);
  const hasTextContent = cleanTextParts.some((text) => text.trim().length > 0);
  const fileParts = message.parts.filter(isFilePart);

  // Build fallback summary from tool outputs
  let fallbackSummary = '';
  if (!hasTextContent && message.role === 'assistant') {
    const summaries: string[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      const partType = typeof part.type === 'string' ? part.type : '';

      // Handle tool-{name} parts (AI SDK 5.x/6.x format)
      if (partType.startsWith('tool-') && part.state === 'output-available' && isRecord(part.output)) {
        const toolName = partType.replace('tool-', '');
        if (
          shouldRenderToolResult(toolName, mode, allowlist)
          && typeof part.output.message === 'string'
          && !isUiActionHandoffMessage(part.output.message)
        ) {
          summaries.push(part.output.message);
        }
      }

      // Handle tool-result parts
      if (
        partType === 'tool-result'
        && typeof part.toolName === 'string'
        && shouldRenderToolResult(part.toolName, mode, allowlist)
        && isRecord(part.result)
      ) {
        if (typeof part.result.message === 'string' && !isUiActionHandoffMessage(part.result.message)) {
          summaries.push(part.result.message);
        }
      }
    }
    fallbackSummary = summaries[0] ?? '';
  }

  // Skip truly empty assistant messages
  let visible = true;
  if (
    message.role === 'assistant'
    && !notice
    && !hasTextContent
    && !fallbackSummary
    && activitySteps.length === 0
    && !hasPlan
    && fileParts.length === 0
  ) {
    const hasVisibleToolOutput = message.parts.some(p => {
      if (readClarificationPart(p)) return true;
      if (readChatViewPart(p)?.view) return true;
      if (!isRecord(p)) return false;
      const t = typeof p.type === 'string' ? p.type : '';
      if (t.startsWith('tool-') && p.state === 'output-available') {
        const toolName = t.replace('tool-', '');
        return shouldRenderToolResult(toolName, mode, allowlist);
      }
      return (
        t === 'tool-result'
        && typeof p.toolName === 'string'
        && shouldRenderToolResult(p.toolName, mode, allowlist)
      );
    });
    if (!hasVisibleToolOutput) visible = false;
  }

  const textNodes = cleanTextParts.map((text, i) => {
    const segments = parseMentionSegments(text, mentionPrefix);
    const hasMention = segments.some((segment) => segment.kind === 'mention');

    if (!hasMention) {
      if (!text.trim()) return null;
      return (
        <MarkdownComponent
          key={`text-${i}`}
          content={text}
        />
      );
    }

    // `entityLinks.mentionMarkers: 'markdown'`: the answer keeps its Markdown, each marker a chip inside it.
    if (linkText && links.mentionMarkers === 'markdown') {
      const { content, mentions } = markdownWithMentionMarkers(segments);
      return (
        <MentionMarkers key={`text-${i}`} mentions={mentions}>
          <MarkdownComponent content={content} />
        </MentionMarkers>
      );
    }

    return (
      <div key={`mention-text-${i}`} data-component="message-rich-text">
        {segments.map((segment, index) => {
          if (segment.kind === 'text') {
            if (!segment.text) return null;
            return (
              <span key={`segment-text-${index}`} data-component="message-rich-text-part">
                {linkText ? <EntityText text={segment.text} /> : segment.text}
              </span>
            );
          }

          return (
            <MentionChipComponent
              key={`segment-mention-${index}`}
              mention={segment.mention}
              inline
              {...(segment.mention.type !== 'command' && links.canOpen(segment.mention.type)
                ? {
                  onOpen: () => links.open({ type: segment.mention.type, id: segment.mention.id, label: segment.mention.displayName }),
                  openLabel: links.openLabel({ type: segment.mention.type, id: segment.mention.id, label: segment.mention.displayName }),
                }
                : {})}
            />
          );
        })}
      </div>
    );
  });
  /** The approval of a tool part, read once when asked for (`MessagePartEntry.approval`, the nodes below). */
  const approvals = new Map<number, ToolPartApproval | undefined>();
  const toolResultNodes = message.parts.map((part, i) => {
    const node = toolResultNode(part, i);
    const approval = approvalNode(part, i);
    if (!approval) return node;
    return (
      <Fragment key={`tool-part-${i}`}>
        {approval}
        {node}
      </Fragment>
    );
  });

  function toolResultNode(part: ChatMessage['parts'][number], i: number): ReactNode {
    const clarification = readClarificationPart(part);
    if (clarification) {
      return (
        <ClarificationComponent
          key={`clarification-${clarification.toolCallId}`}
          toolCallId={clarification.toolCallId}
          request={clarification.request}
          interactive={clarification.ready && isLatestMessage && !isLoading}
          {...(composer?.clarificationChips ? { showOptions: false } : {})}
          onAnswer={(answer) => send(clarificationAnswerMessage({
            toolCallId: clarification.toolCallId,
            answer: answer.text,
            ...(answer.optionId ? { optionId: answer.optionId } : {}),
          }))}
        />
      );
    }

    const chatView = readChatViewPart(part);
    if (chatView) {
      // Running or failed: nothing here (the model answers in text).
      if (!chatView.view) return null;
      const { toolCallId } = chatView;
      return (
        <ChatView
          key={`chat-view-${toolCallId || i}`}
          view={chatView.view}
          {...(chatViewRegistry ? { registry: chatViewRegistry } : {})}
          locale={language ?? 'en'}
          texts={{
            ...(locale.chatViewSaidMarker ? { said: locale.chatViewSaidMarker } : {}),
            ...(locale.chatViewPartialNote ? { partial: locale.chatViewPartialNote } : {}),
            ...(locale.chatViewMoreRows ? { more: locale.chatViewMoreRows } : {}),
          }}
          dispatch={{
            prompt: (text) => { send(text); },
            uiAction: (id, args) => runChatViewAction?.(id, args, toolCallId),
          }}
        />
      );
    }

    // Standard ToolResultPart
    if ('toolName' in part && 'result' in part && part.result !== undefined) {
      if (!shouldRenderToolResult(part.toolName, mode, allowlist)) return null;
      return renderToolResult(`tool-${i}`, part.toolName, part.result);
    }

    // AI SDK 5.x/6.x tool-{name} parts with output
    if (isRecord(part)) {
      const partType = typeof part.type === 'string' ? part.type : '';
      if (partType.startsWith('tool-') && part.state === 'output-available' && part.output !== undefined) {
        const toolName = partType.replace('tool-', '');
        if (!shouldRenderToolResult(toolName, mode, allowlist)) return null;
        return renderToolResult(`tool-${i}`, toolName, part.output);
      }
    }

    return null;
  }

  /**
   * An approved call without a result, once the turn no longer runs: stopped, unless the chat still sends it by
   * itself (another approval of the message is open, or the automatic resend after this answer is to come).
   */
  function settled(approval: ToolPartApproval | undefined): ToolPartApproval | undefined {
    if (!approval || approval.outcome !== 'running' || isLatestMessage && isLoading) return approval;
    const resendPending = isLatestMessage && (
      message.parts.some((part) => isRecord(part) && part.state === 'approval-requested')
      || isApprovalResendPending?.(approval.approvalId) === true
    );
    return resendPending ? approval : { ...approval, outcome: 'aborted' };
  }

  function approvalAt(i: number): ToolPartApproval | undefined {
    if (!approvals.has(i)) {
      const part = message.parts[i];
      const toolName = isRecord(part) ? toolPartName(part) : null;
      approvals.set(i, toolName && isAssistant
        ? settled(readToolPartApproval(part, {
          toolName,
          pending: pendingApprovals ?? [],
          messages: messages ?? [message],
          declarations: entityDeclarations,
          describe: approvalDescription ?? ((name, id, args) => ({ id, toolName: name, args: isRecord(args) ? args : {}, messageId: message.id })),
          withSubjects: approvalSubjects !== false,
          ...(language ? { language } : {}),
        }))
        : undefined);
    }
    return approvals.get(i);
  }

  /** The approval entry or inline card at a tool part (`approvalDisplay`); null by default. */
  function approvalNode(part: ChatMessage['parts'][number], i: number): ReactNode {
    const display = approvalDisplay ?? { decided: 'none', open: 'panel' };
    if (display.decided === 'none' && display.open === 'panel') return null;
    if (!isRecord(part) || !isRecord(part.approval)) return null;
    const approval = approvalAt(i);
    if (!approval) return null;
    if (approval.state === 'decided') {
      return display.decided === 'entry' ? <ApprovalEntryComponent approval={approval} /> : null;
    }
    if (display.open !== 'inline' || !approval.pending) return null;
    return (
      <ApprovalCardComponent
        approval={approval.pending}
        onApprove={approve}
        onReject={reject}
        isProcessing={isProcessingApproval}
      />
    );
  }

  /** The answer's footer (`messageFooter`), null when it is off or not an answer. */
  function footerNode(): ReactNode {
    if (!isAssistant || (!messageFooter && suggestions?.placement !== 'message')) return null;
    const index = messages ? messages.findIndex((entry) => entry.id === message.id) : -1;
    const next = index >= 0 ? messages![index + 1] : undefined;
    return (
      <MessageFooter
        message={message}
        text={hasTextContent ? cleanTextParts.filter((text) => text.trim()).join('\n\n') : fallbackSummary}
        hasText={hasTextContent || Boolean(fallbackSummary)}
        isLastOfTurn={!next || next.role === 'user'}
        isLatest={isLatestMessage}
        turnOutcome={turnOutcome}
        // A session change (create, delete, load) is not a running turn.
        active={isLatestMessage && (isTurnRunning ?? isLoading)}
      />
    );
  }

  /** "Continue" under a budget stop notice: the latest answer, stopped at a limit the server offers to continue. */
  function continuationNode(): ReactNode {
    if (!isAssistant || !isLatestMessage || isLoading || !continueAfterBudgetStop) return null;
    if (!endsWithContinuableBudgetStop(message)) return null;
    return (
      <div data-element="budget-continue">
        <button type="button" data-action="continue-after-stop" onClick={() => continueAfterBudgetStop()}>
          {locale.continueButton}
        </button>
      </div>
    );
  }

  // `activityLog.grouping: 'sections'`: a log per run of steps, at its place between the texts.
  const sections = (activityLog?.grouping ?? 'message') === 'sections' && isAssistant && activitySteps.length > 0
    ? activitySections(message.parts, textEntries.map((entry, i) => ({ index: entry.index, node: textNodes[i] ?? null })), readSteps)
    : null;
  const lastStepsSection = sections ? sections.map((section) => section.kind).lastIndexOf('steps') : -1;
  const logsAt = new Map<number, ReactNode>();
  const sectionNodes = sections?.map((section, i) => {
    if (section.kind === 'text') return section.node;
    const last = i === lastStepsSection;
    const log = (
      <ActivityLog
        key={`activity-${i}-${section.steps[0]!.id}`}
        steps={section.steps}
        // An earlier section with a call still running is part of the running turn too (not stopped).
        active={turnActive && (last || section.steps.some((step) => step.status === 'running'))}
        {...(last && notice && noticeInLog ? { notice: notice.text, noticeStatus: notice.status, ...logNoticeOutcome } : {})}
      />
    );
    logsAt.set(section.start, scoped(log));
    return log;
  });

  const nodes = {
    plan: hasPlan ? <PlanChecklist items={planItems!} active={turnActive} /> : null,
    activity: sectionNodes ? null : activitySteps.length > 0
      ? (
        <ActivityLog
          steps={activitySteps}
          active={turnActive}
          {...(notice && noticeInLog ? { notice: notice.text, noticeStatus: notice.status, ...logNoticeOutcome } : {})}
        />
      )
      : null,
    notice: notice && !noticeInLog
      ? <TurnNoticeComponent text={notice.text} status={notice.status} placement="message" {...noticeOutcome} />
      : null,
    attachments: fileParts.length > 0
      ? (
        <div data-element="message-attachments">
          {fileParts.map((part, i) => <MessageAttachment key={`file-${i}`} part={part} locale={locale} />)}
        </div>
      )
      : null,
    text: sectionNodes ? <>{sectionNodes}</> : hasTextContent || fallbackSummary
      ? (
        <>
          {textNodes}
          {/* Fallback summary if no text parts */}
          {!hasTextContent && fallbackSummary && <MarkdownComponent content={fallbackSummary} />}
        </>
      )
      : null,
    toolResults: toolResultNodes.some((node) => node !== null) ? <>{toolResultNodes}</> : null,
    continuation: continuationNode(),
    footer: footerNode(),
  };
  const textNodeAt = new Map(textEntries.map((entry, i) => [entry.index, textNodes[i] ?? null] as const));
  const parts = message.parts.map((part, index): MessagePartEntry => {
    const kind = partKind(part);
    const toolName = kind === 'tool' && isRecord(part) ? toolPartName(part) ?? undefined : undefined;
    const toolCallId = isRecord(part) && typeof part.toolCallId === 'string' && part.toolCallId ? part.toolCallId : undefined;
    const node = kind === 'text'
      ? textNodeAt.get(index) ?? null
      : kind === 'file'
        ? <MessageAttachment key={`file-${index}`} part={part as FilePart} locale={locale} />
        : kind === 'tool' ? toolResultNodes[index] ?? null : null;
    const entry: MessagePartEntry = {
      key: kind === 'tool' && toolCallId ? `tool:${toolCallId}` : `${kind}:${index}`,
      index,
      kind,
      part,
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      node: scoped(node),
    };
    if (kind === 'tool' && isRecord(part) && isRecord(part.approval)) {
      // Read when asked for: describing a decided approval walks the conversation.
      Object.defineProperty(entry, 'approval', { enumerable: true, get: () => approvalAt(index) });
    }
    return entry;
  });

  return {
    visible,
    parts,
    turnOutcome,
    logsAt,
    plan: scoped(nodes.plan),
    activity: scoped(nodes.activity),
    notice: scoped(nodes.notice),
    attachments: scoped(nodes.attachments),
    text: scoped(nodes.text),
    toolResults: scoped(nodes.toolResults),
    continuation: nodes.continuation,
    footer: scoped(nodes.footer),
  };
}

/**
 * Single message bubble.
 *
 * Renders text parts via Markdown component, mention markers as chips,
 * tool results via ToolResultBlock, and handles AI SDK 5.x/6.x tool part
 * format (`type: 'tool-{name}'`). `components.MessageParts` may arrange the
 * parts itself; `useMessageParts` gives them to a custom bubble.
 *
 * Uses `data-role` attribute for styling (user/assistant/system).
 */
export function MessageBubble({ message, className }: MessageBubbleProps) {
  const { classNames, components, approvalDisplay } = useMessageChat();
  const { visible, parts, logsAt, turnOutcome, ...nodes } = useMessagePartsWithLogs(message);
  if (!visible) return null;
  // With `approvalDisplay` placing approvals at their tool part, a message that
  // has one renders its text and tool parts in message order, so the approval
  // sits between the texts around it. Otherwise the default order, unchanged:
  // plan, log, notice, attachments, text, results. With
  // `activityLog.grouping: 'sections'` each section's log goes before the
  // first tool part of its run, as in `nodes.text`.
  const display = approvalDisplay ?? { decided: 'none', open: 'panel' };
  const inOrder = (display.decided !== 'none' || display.open !== 'panel')
    && parts.some((entry) => entry.kind === 'text' && entry.node !== null)
    && parts.some((entry) => entry.kind === 'tool' && isRecord(entry.part) && isRecord(entry.part.approval));
  const ordered = (
    <>
      {nodes.plan}
      {nodes.activity}
      {nodes.notice}
      {nodes.attachments}
      {inOrder
        ? parts.filter((entry) => entry.kind === 'text' || entry.kind === 'tool')
          .map((entry) => (
            <Fragment key={entry.key}>
              {logsAt.get(entry.index) ?? null}
              {entry.node}
            </Fragment>
          ))
        : (
          <>
            {nodes.text}
            {nodes.toolResults}
          </>
        )}
      {nodes.continuation}
      {nodes.footer}
    </>
  );
  const Arrange = components.MessageParts;

  return (
    <div
      className={className ?? classNames.messageBubble}
      data-component="message-bubble"
      data-role={message.role}
    >
      {Arrange ? <Arrange message={message} parts={parts} turnOutcome={turnOutcome} {...nodes}>{ordered}</Arrange> : ordered}
    </div>
  );
}

function DefaultMarkdown({ content, className }: { content: string; className?: string }) {
  const links = useChatEntityLinks();
  const { remarkPlugins, loadingTimeoutMs } = useChatMarkdownOptions();
  const limit = markdownLoadingLimit(loadingTimeoutMs);
  // Optional: rendered outside the provider (print, renderToStaticMarkup) it behaves as before.
  const chat = useOptionalMessageChat();
  // Outside a provider both snapshots are `false`: no re-render after hydration, as before.
  const client = useSyncExternalStore(subscribeNothing, chat ? onClient : onServer, onServer);
  // Skeleton or raw text while react-markdown loads, decided on the first render
  // and kept until Markdown renders; decided again only for a text that no
  // longer continues the decided one (a bubble reused for another message).
  // The server and the hydration render decide raw, as before.
  const decide = (): FallbackChoice => ({
    content,
    skeleton: client && chat !== null && !chat.isLoading && limit !== 0
      && !(limit !== false && markdownOverdue(limit)) && needsMarkdown(content, links.enabled),
  });
  const [choice, setChoice] = useState(decide);
  let skeleton = choice.skeleton;
  if (chat && !content.startsWith(choice.content)) {
    const next = decide();
    skeleton = next.skeleton;
    setChoice(next);
  }
  // The one exception to "decided once": a skeleton turns into the raw text when
  // react-markdown has not arrived within the limit (it still turns into Markdown).
  const waitFor = skeleton && limit !== false ? limit : null;
  const subscribe = useCallback(
    (listener: () => void) => (waitFor === null ? () => {} : subscribeMarkdownTimeout(waitFor, listener)),
    [waitFor],
  );
  const timedOut = useSyncExternalStore(subscribe, () => waitFor !== null && markdownTimedOut(waitFor), onServer);
  if (timedOut) skeleton = false;
  // The raw text reads mention labels without the escapes the SDK put in for react-markdown.
  const raw = unescapeMarkerLabels(content);
  return (
    <div className={className} data-component="markdown">
      <Suspense fallback={skeleton ? <MarkdownLoading content={raw} label={chat?.locale.markdownLoadingLabel} /> : <>{raw}</>}>
        <ReactMarkdown
          components={links.enabled ? links.markdownComponents : undefined}
          remarkPlugins={remarkPlugins as ReactMarkdownOptions['remarkPlugins']}
        >{content}</ReactMarkdown>
      </Suspense>
    </div>
  );
}

interface FallbackChoice { content: string; skeleton: boolean }

const subscribeNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Whether Markdown could show `content` differently from its raw text. One
 * pass, no regex. Markdown-significant: a backslash or any of ` * _ [ ] < > &
 * | ~ # : @, a line break, tab, carriage return or NUL, the zero-width mention
 * marker characters (U+2060, U+2063, U+200B, U+200C), leading whitespace, a
 * leading - + = or ordered-list number (`1.`, `1)`), and `www.` in any case
 * (an autolink with remark-gfm). With entity links on, any text may become chips.
 */
function needsMarkdown(content: string, entityLinks: boolean): boolean {
  if (entityLinks || content.length === 0) return true;
  const first = content.charCodeAt(0);
  if (first === 32 || first === 45 || first === 43 || first === 61) return true; // space - + =
  let digits = 0;
  let ws = 0;
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (MARKDOWN_SIGNIFICANT.has(code)) return true;
    if (digits === i && code >= 48 && code <= 57) digits += 1;
    else if (digits > 0 && digits === i && (code === 46 || code === 41)) return true; // 1. or 1)
    // `www.` in any case: count w/W in a row, a dot after three or more.
    if (code === 119 || code === 87) ws += 1;
    else if (code === 46 && ws >= 3) return true;
    else ws = 0;
  }
  return false;
}

const MARKDOWN_SIGNIFICANT = new Set(
  [...'\\`*_[]<>&|~#:@\n\r\t\u0000\u2060\u2063\u200B\u200C'].map((char) => char.charCodeAt(0)),
);

const MAX_SKELETON_LINES = 8;
/** Characters per skeleton line, also its widest size in `ch`. */
const SKELETON_COLUMNS = 40;
const SKELETON_SCAN_LIMIT = 2_000;

/**
 * Lines, width (in `ch`) and last-line width (percent) the rendered text will
 * roughly take: one line per non-empty source line plus one per 40 characters,
 * as wide as its longest line up to 40. A single pass over at most the first
 * 2,000 characters, stopped at 8 lines.
 */
function estimateSkeleton(content: string): { lines: number; columns: number; lastWidth: number } {
  let lines = 0;
  let lineLength = 0;
  let columns = 1;
  const end = Math.min(content.length, SKELETON_SCAN_LIMIT);
  for (let i = 0; i < end && lines < MAX_SKELETON_LINES; i += 1) {
    if (content.charCodeAt(i) === 10) {
      if (lineLength > 0) lines += 1;
      lineLength = 0;
      continue;
    }
    if (lineLength === SKELETON_COLUMNS) {
      lines += 1;
      lineLength = 0;
    }
    lineLength += 1;
    if (lineLength > columns) columns = lineLength;
  }
  if (lineLength > 0 && lines < MAX_SKELETON_LINES) lines += 1;
  const lastWidth = lines < MAX_SKELETON_LINES && lineLength > 0
    ? Math.max(30, Math.round((lineLength / columns) * 100))
    : 100;
  return { lines: Math.max(1, lines), columns, lastWidth };
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

const SPACER_COLUMNS = 5;
const SPACER_STYLE: CSSProperties = { flex: 'none', inlineSize: `${SPACER_COLUMNS}ch`, blockSize: 0 };

/**
 * Empty wrapping boxes that give the skeleton its width from the source: as
 * wide as `columns` characters where there is room (a bubble sized by its
 * content), but they wrap, so the skeleton never widens a narrower container.
 */
function widthSpacers(columns: number): ReactNode[] {
  return Array.from({ length: Math.ceil(columns / SPACER_COLUMNS) }, (_, index) => <span key={index} style={SPACER_STYLE} />);
}

/**
 * Suspense fallback while react-markdown loads, for text outside a running
 * turn: skeleton lines sized from the source. The geometry is inline (CSS
 * variables) so it takes space without the SDK stylesheet too, also in a
 * bubble sized by its content.
 */
function MarkdownLoading({ content, label }: { content: string; label?: string }) {
  const { lines, columns, lastWidth } = estimateSkeleton(content);
  return (
    <div
      data-element="markdown-skeleton"
      data-state="loading"
      aria-busy="true"
      // The copy button copies the source, as before the skeleton (not kept in the DOM).
      ref={(element) => { if (element) loadingMarkdownSources.set(element, content); }}
      style={{
        display: 'grid',
        maxInlineSize: 'var(--cm-markdown-skeleton-max-width, 100%)',
        rowGap: 'var(--cm-markdown-skeleton-gap, 0.625em)',
        paddingBlock: 'var(--cm-markdown-skeleton-padding, 0.3125em)',
      }}
    >
      <span style={VISUALLY_HIDDEN}>{label ?? 'Loading message…'}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          data-element="markdown-skeleton-line"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            overflow: 'hidden',
            width: index === lines - 1 ? `${lastWidth}%` : '100%',
            height: 'var(--cm-markdown-skeleton-line-height, 0.875em)',
            borderRadius: 'var(--cm-markdown-skeleton-radius, 0.25em)',
            background: 'var(--cm-markdown-skeleton-color, rgba(127, 127, 127, 0.2))',
          }}
        >
          {index === 0 ? widthSpacers(columns) : null}
        </span>
      ))}
    </div>
  );
}

function DefaultToolResult({
  toolName,
  result,
  className,
}: {
  toolName: string;
  result: unknown;
  className?: string;
}) {
  // A UI tool's hand-off note is for the model; the app shows the action itself.
  if (isRecord(result) && isUiActionHandoffMessage(result.message)) return null;
  if (isRecord(result) && typeof result.message === 'string' && result.message.trim().length > 0) {
    return (
      <div className={className} data-component="tool-result" data-tool={toolName}>
        {result.message}
      </div>
    );
  }

  return (
    <details className={className} data-component="tool-result" data-tool={toolName}>
      <summary>{toolName}</summary>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </details>
  );
}
