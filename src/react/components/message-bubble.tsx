import { Fragment, Suspense, lazy, type ReactNode } from 'react';
import { MentionChip as DefaultMentionChip } from './mention-chip.js';
import { useChatContext } from '../provider/chat-context.js';
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
import { readActivitySteps, readLatestPlan, type ActivityDetailSource, type ActivityStep, type ActivityStepStatus } from '../utils/activity.js';
import { PLAN_TOOL_NAME } from '../../contracts/plan.js';
import { RendererBoundary } from '../tool-renderers/renderer-boundary.js';
import {
  CLARIFICATION_TOOL_NAME,
  stripClarificationMarkers,
} from '../../contracts/clarification.js';
import { stripChatCommandMarkers } from '../../contracts/chat-command.js';
import { isUiActionHandoffMessage } from '../../browser/ui-action-handoff.js';
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
} from '../types.js';

// Lazy-load react-markdown — keeps it out of the synchronous import graph so
// server-only consumers don't pay for it, and gracefully degrades to raw text
// when the optional peer dep isn't installed.
type MarkdownModule = typeof import('react-markdown');

const ReactMarkdown = lazy<MarkdownModule['default']>(async () => {
  try {
    const mod = await import('react-markdown');
    return { default: mod.default };
  } catch {
    if (typeof console !== 'undefined') {
      console.warn(
        '[MessageBubble] react-markdown is not installed — falling back to plain text. Install it with: npm install react-markdown',
      );
    }
    const Fallback: MarkdownModule['default'] = (({ children }) => (
      <>{typeof children === 'string' ? children : ''}</>
    )) as MarkdownModule['default'];
    return { default: Fallback };
  }
});

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
  switch (state?.status) {
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
    approvalDescription,
    approvalSubjects,
    approvalDisplay,
    entityDeclarations,
    language,
  } = useChatContext();
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
  const readSteps = (parts: ReadonlyArray<unknown>): ActivityStep[] => readActivitySteps(
    parts,
    (toolName, status, source) => allowStepDetail(details, status, source, resultShown(toolName)),
  ).map((step) => (
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
  // Only an assistant turn carries the notice; a stored turn (not the latest) has none.
  const notice = isAssistant && isLatestMessage ? pipelineNotice(pipelineState, locale) : undefined;
  // Inside the log by default; outside it on request, and always when there is no log to hold it.
  const noticeInLog = notice !== undefined
    && (activityLog?.noticePlacement ?? 'log') === 'log'
    && activitySteps.length > 0;

  // Extract tool result summaries as fallback text when no text parts exist
  const textEntries = message.parts
    .map((part, index) => ({ part, index }))
    .filter((entry): entry is { part: TextPart; index: number } => isTextPart(entry.part))
    .filter((entry) => entry.part.text.trim())
    .map(({ part, index }) => {
      const text = stripChatCommandMarkers(stripClarificationMarkers(stripContextBlocks(part.text)));
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
    const segments = parseMentionSegments(text);
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
          onAnswer={(answer) => send(clarificationAnswerMessage({
            toolCallId: clarification.toolCallId,
            answer: answer.text,
            ...(answer.optionId ? { optionId: answer.optionId } : {}),
          }))}
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

  function approvalAt(i: number): ToolPartApproval | undefined {
    if (!approvals.has(i)) {
      const part = message.parts[i];
      const toolName = isRecord(part) ? toolPartName(part) : null;
      approvals.set(i, toolName && isAssistant
        ? readToolPartApproval(part, {
          toolName,
          pending: pendingApprovals ?? [],
          messages: messages ?? [message],
          declarations: entityDeclarations,
          describe: approvalDescription ?? ((name, id, args) => ({ id, toolName: name, args: isRecord(args) ? args : {}, messageId: message.id })),
          withSubjects: approvalSubjects !== false,
          ...(language ? { language } : {}),
        })
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
        active={turnActive && last}
        {...(last && notice && noticeInLog ? { notice: notice.text, noticeStatus: notice.status } : {})}
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
          {...(notice && noticeInLog ? { notice: notice.text, noticeStatus: notice.status } : {})}
        />
      )
      : null,
    notice: notice && !noticeInLog
      ? <TurnNoticeComponent text={notice.text} status={notice.status} placement="message" />
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
    logsAt,
    plan: scoped(nodes.plan),
    activity: scoped(nodes.activity),
    notice: scoped(nodes.notice),
    attachments: scoped(nodes.attachments),
    text: scoped(nodes.text),
    toolResults: scoped(nodes.toolResults),
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
  const { classNames, components, approvalDisplay } = useChatContext();
  const { visible, parts, logsAt, ...nodes } = useMessagePartsWithLogs(message);
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
    </>
  );
  const Arrange = components.MessageParts;

  return (
    <div
      className={className ?? classNames.messageBubble}
      data-component="message-bubble"
      data-role={message.role}
    >
      {Arrange ? <Arrange message={message} parts={parts} {...nodes}>{ordered}</Arrange> : ordered}
    </div>
  );
}

function DefaultMarkdown({ content, className }: { content: string; className?: string }) {
  const links = useChatEntityLinks();
  return (
    <div className={className} data-component="markdown">
      <Suspense fallback={<>{content}</>}>
        <ReactMarkdown components={links.enabled ? links.markdownComponents : undefined}>{content}</ReactMarkdown>
      </Suspense>
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
