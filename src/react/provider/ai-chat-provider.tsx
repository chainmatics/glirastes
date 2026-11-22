import {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { getThemeEffect, getThemeVars } from '../themes.js';
import { ChatContext, type ChatContextValue } from './chat-context.js';
import type { ComposerContextValue } from './composer-context.js';
import type {
  ActivityLogConfig,
  ActivityLogDetails,
  ApprovalDisplayConfig,
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  FilePart,
  PendingApproval,
  MentionResult,
  MentionData,
  TruncationInfo,
  PipelineState,
  PipelineStepReport,
  TurnOutcome,
  TurnOutcomeReason,
  SessionSummary,
  ChatQueueApi,
  ChatQueuePauseTrigger,
  ChatQueueState,
  ChatSubmitResult,
  ChatSubmitOutcome,
  ChatSubmitRejection,
  ChatSubmitRejectionReason,
  QueuedMessage,
} from '../types.js';
import { createQueuedMessage, useMessageQueueStore, useResolvedQueueConfig } from './use-message-queue.js';
import { inferMentionPrefix, normalizeMentionSlug, serializeMentionsForSend } from '../utils/mention-markup.js';
import { mergePipelineSteps } from '../utils/merge-pipeline-steps.js';
import { resolveAttachmentOptions } from '../utils/attachments.js';
import { clearChatAttachmentSource, setActiveChatAttachmentSource } from '../utils/chat-attachment-registry.js';
import { sanitizeEntityDeclarations, type EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import { describeApprovalCall } from '../utils/describe-approval.js';
import { createApprovalDescriptionGenerator } from '../utils/create-approval-description.js';
import { languageLocale, parseToolPresentation, usePageLanguage, type ToolPresentation } from '../utils/tool-presentation.js';
import { resolveToolResultConfig } from '../utils/tool-result-config.js';
import { extractTrailingFollowupSuggestions } from '../utils/followup-suggestions.js';
import { clarificationAnswerMessage, findOpenClarification } from '../utils/clarification.js';
import { createCompletionSearch } from '../completions/completion-search.js';
import { createMentionPrefixLookup, resolveChatTriggers } from '../completions/triggers.js';
import { toChatEntityItem } from '../interactions/definitions.js';
import {
  createChatInteractionRegistry,
  type PendingChatCommand,
} from '../interactions/registry.js';
import { createToolResultRendererRegistry } from '../tool-renderers/registry.js';
import { ChatComposerQueueProvider } from '../composer/chat-composer.js';
import { createComposerDraftController, type ComposerDraftController } from '../composer/composer-drafts.js';
import { ChatMarkdownOptionsContext, NO_MARKDOWN_OPTIONS } from '../markdown-options.js';
import { ChatEntityLinksProvider } from '../entity-links/entity-links-react.js';
import {
  runToolResultUiActions,
  toolResultUiActions,
  UI_ACTION_OUTCOME_TIMEOUT_MS,
  type UiActionRunCode,
} from '../../browser/client-actions.js';
import {
  BEFORE_PAGE_LOAD_TIMEOUT_MS,
  onBeforeUiActionPageLoad,
  onUiActionPageLoadResult,
  type UiActionPageLoadResult,
} from '../../browser/ui-action-signals.js';
import type { UiAction } from '../../browser/ui-action-bus.js';
import type { UiOutcome } from '../../contracts/ui-outcome.js';
import { continuesAfterPageLoad, shouldContinueChat, waitingToolCallIds } from '../utils/ui-outcome-continuation.js';
import { getDefaultUiActionBus } from '../../browser/ui-action-bus.js';
import { resolveTextTable } from '../../contracts/localized-text.js';
import { deChatLocale } from '../locale-de.js';
import { STEP_FAILURE_TEXTS_EN } from '../utils/step-failure.js';
import { latestUserMessageId, readStoredTurnOutcomes, withStoredTurnOutcomes } from '../utils/turn-outcomes.js';
import {
  CLARIFICATION_MAX_ANSWER_LENGTH,
  parseClarificationAnswer,
} from '../../contracts/clarification.js';

// ============================================================================
// Default locale (English)
// ============================================================================

import type { ApprovalDescriptionFn, ChatLocale, ToolLabelConfig } from '../types.js';

export const DEFAULT_LOCALE: ChatLocale = {
  placeholder: 'Type a message...',
  sendButton: 'Send',
  stopButton: 'Stop',
  clearButton: 'Clear',
  loadMoreButton: 'Load more',
  emptyState: 'Start a conversation',
  errorMessage: 'Something went wrong. Please try again.',
  approveButton: 'Approve',
  rejectButton: 'Reject',
  approveAllButton: 'Approve all',
  rejectAllButton: 'Reject all',
  continueButton: 'Continue',
  dismissButton: 'Dismiss',
  cancelButton: 'Cancel',
  confirmButton: 'Confirm',
  approvalPendingHint: 'Please approve or reject the open request first.',
  approvalTargetLabel: 'Target',
  approvalUnknownIdWarning: 'No name is known for this id in this conversation. Check it before you approve.',
  approvalUnknownIdsWarning: 'No names are known for these ids in this conversation. Check them before you approve.',
  approvalAmbiguousIdWarning: 'This id came up with different names: {names}. Check it before you approve.',
  approvalCollidingIdWarning: 'This id came up for different kinds of records: {candidates}. Check which one is meant before you approve.',
  approvalSeenIdNote: 'seen in this conversation',
  approvalSubjectUncheckedWarning: '{label} {id} could not be checked right now.',
  approvalSubjectsUncheckedWarning: 'These could not be checked right now: {ids}.',
  approvalReferenceIdNote: 'Referenced, not checked.',
  approvalPreviewUncheckedNote: 'The preview could not be loaded.',
  moreItemsLabel: 'more',
  showAllItemsLabel: 'Show all {count}',
  showMoreLabel: 'Show more',
  showLessLabel: 'Show less',
  allCountLabel: 'All {count}',
  pipelineTitle: 'Pipeline',
  pipelineRunningLabel: 'Running',
  pipelineCompletedLabel: 'Completed',
  pipelineSafetyStopLabel: 'Safety stop',
  pipelineAbortedLabel: 'Stopped',
  pipelineErrorLabel: 'Error',
  pipelineStepLabel: 'Step',
  pipelineApprovalPendingLabel: 'Approval pending',
  activityWorkingLabel: 'Working',
  activityWaitingLabel: 'Waiting for approval',
  activityDoneLabel: '{count} steps done',
  activityDoneOneLabel: '1 step done',
  activityFailedLabel: '{count} failed',
  activityDeclinedLabel: '{count} declined',
  activityExpectedLabel: '{count} without result',
  activityAbortedLabel: '{count} stopped',
  activityRunningLabel: '{label}…',
  activityRunningProgressLabel: '{count} done, {label}…',
  activityStepCountLabel: '×{count}',
  activitySummarySeparator: ', ',
  activityApprovalNotUsedDetail: 'The approval could not be used',
  // Word for word the texts the server and the SDK's tools write (`activityFailure…`).
  ...STEP_FAILURE_TEXTS_EN,
  activityUiPendingLabel: 'Waiting for the app',
  activityUiRejectedContract: 'Rejected by the app (invalid input)',
  activityUiRejectedHandler: 'Not carried out by the app',
  activityUiUnavailable: 'Not available on this page',
  activityUiFailed: 'Failed in the app',
  activityUiInitiated: 'Started',
  activityUiUnconfirmed: 'Not confirmed',
  approvalEntryRunningLabel: 'Approved, running',
  approvalEntryDoneLabel: 'Approved, done',
  approvalEntryFailedLabel: 'Approved, failed',
  approvalEntryExpectedLabel: 'Approved, without result',
  approvalEntryDeclinedLabel: 'Declined',
  approvalEntryNotRunLabel: 'Approved, not run',
  approvalEntryAbortedLabel: 'Approved, stopped',
  planTitle: 'Plan',
  chatTitle: 'AI Assistant',
  closeChatAriaLabel: 'Close chat',
  clearChatAriaLabel: 'Clear conversation',
  confirmClearPrompt: 'Clear this conversation?',
  triggerAriaLabel: 'AI Assistant',
  micAriaLabel: 'Start recording',
  stopRecordingAriaLabel: 'Stop recording',
  cancelRecordingAriaLabel: 'Cancel recording',
  newChatLabel: 'New chat',
  noSessionsLabel: 'No conversations yet',
  sessionsLoadingLabel: 'Loading…',
  untitledSessionLabel: 'Untitled',
  deleteSessionAriaLabel: 'Delete conversation',
  confirmDeleteSessionPrompt: 'Delete this conversation?',
  sessionArchiveMessage: '"{title}" will be archived.',
  renameSessionAriaLabel: 'Rename conversation',
  renameSessionPlaceholder: 'Conversation title',
  clarificationInputLabel: 'Your answer',
  clarificationSubmitButton: 'Answer',
  retryRecordingAriaLabel: 'Retry recording',
  completionListLabel: 'Suggestions',
  completionResultsLabel: '{count} suggestions',
  completionEmptyLabel: 'No matches. @ for things, / for commands',
  commandArgumentsLabel: 'Details for {command}',
  commandArgumentsSubmit: 'Run',
  commandArgumentsInvalid: 'These values are too long.',
  commandArgumentsIncomplete: 'Please complete: {fields}',
  commandArgumentsAnyOption: 'Any',
  commandArgumentsNoMatches: 'No matches',
  removeMentionLabel: 'Remove {label}',
  openEntityLabel: 'Open {label}',
  chatAboutLabel: 'Chat about this',
  attachButtonLabel: 'Attach files',
  plusMenuButtonLabel: 'More actions',
  plusMenuAttachLabel: 'Attach file',
  composerHintSend: 'Send',
  composerHintNewline: 'New line',
  composerHintNavigate: 'Navigate',
  composerHintPick: 'Pick suggestion',
  composerHintClose: 'Close',
  startersLabel: 'Suggestions',
  clarificationChipsLabel: 'Answer options',
  attachmentsLabel: 'Attachments',
  removeAttachmentLabel: 'Remove {name}',
  openAttachmentLabel: 'Open {name}',
  attachmentAddedLabel: '{name} attached',
  attachmentUnavailableLabel: 'No longer available',
  attachmentTooLarge: '{name} is larger than {size}.',
  attachmentTypeNotAllowed: '{name} is not a supported file type.',
  attachmentTooMany: 'At most {count} files per message.',
  attachmentReadFailed: '{name} could not be read.',
  attachmentCommandRefused: 'Commands cannot carry attachments. Remove them or write a message.',
  attachmentUnsupported: 'This chat cannot send attachments.',
  queueTitle: 'Queued ({count})',
  queueSendNowLabel: 'Send now',
  queueEditLabel: 'Edit',
  queueRemoveLabel: 'Remove',
  queuePausedLabel: 'The queue is paused.',
  queueResumeLabel: 'Resume',
  queueSaveLabel: 'Save',
  queueCancelLabel: 'Cancel',
  queueFilesLabel: '{count} files',
  queueApprovalWaitingHint: 'Message waits until the approval is decided.',
};

/** Built-in `approvalPendingHint` → the built-in `queueApprovalWaitingHint` of the same language. */
const BUILT_IN_QUEUE_APPROVAL_HINTS = new Map<string, string>(
  [DEFAULT_LOCALE, deChatLocale].map((table) => [table.approvalPendingHint, table.queueApprovalWaitingHint!]),
);
const BUILT_IN_QUEUE_APPROVAL_HINT_TEXTS = new Set(BUILT_IN_QUEUE_APPROVAL_HINTS.values());

/**
 * Fills `queueApprovalWaitingHint`: the app's own text of that key, else the
 * app's own `approvalPendingHint` (the queued state showed it before the key
 * existed; also over a spread `deChatLocale`, in `locales` or in a full
 * locale without the new key), only then the built-in text of the language.
 * `explicitHint` is what the app itself passed for the new key: a built-in
 * text there counts as its own, except next to an own `approvalPendingHint`,
 * which is what a spread `deChatLocale` with one override looks like.
 */
function withQueueApprovalHint(locale: ChatLocale, explicitHint: string | undefined): ChatLocale {
  const hint = locale.queueApprovalWaitingHint;
  if (hint !== undefined && !BUILT_IN_QUEUE_APPROVAL_HINT_TEXTS.has(hint)) return locale;
  const ownApprovalHint = !BUILT_IN_QUEUE_APPROVAL_HINTS.has(locale.approvalPendingHint);
  if (hint !== undefined && hint === explicitHint && !ownApprovalHint) return locale;
  const followed = BUILT_IN_QUEUE_APPROVAL_HINTS.get(locale.approvalPendingHint) ?? locale.approvalPendingHint;
  return followed === hint ? locale : { ...locale, queueApprovalWaitingHint: followed };
}

const FAILURE_KEYS = Object.keys(STEP_FAILURE_TEXTS_EN) as Array<keyof typeof STEP_FAILURE_TEXTS_EN>;
const isFailureKey = (key: string) => key.startsWith('activityFailure');

/**
 * The failure details of a step (`activityFailure…`) follow the built-in
 * texts of the chat's language only where the app did not word the activity
 * log itself: an app table (`locale`, or its `locales` for the language)
 * that sets any other `activity…` key with a text that is not the built-in
 * one of that language keeps the English texts these details showed before
 * they had keys, unless the app states `language` or sets the key itself.
 * A spread built-in table (`deChatLocale`) carries its own failure texts.
 */
function withFailureTextsOfOwnWording(
  locale: ChatLocale,
  userLocale: Partial<ChatLocale> | undefined,
  userLocales: Readonly<Record<string, Partial<ChatLocale>>> | undefined,
  language: string | null,
  languageStated: boolean,
): ChatLocale {
  if (languageStated) return locale;
  const builtIn = languageLocale(language) as Partial<Record<string, unknown>>;
  const own = [
    userLocale ?? {},
    userLocales ? resolveTextTable<Partial<ChatLocale>>({ requested: language ?? undefined, builtIn: { en: {} }, app: userLocales }) : {},
  ] as Array<Partial<Record<string, unknown>>>;
  const ownWording = own.some((table) => Object.entries(table).some(([key, text]) => (
    key.startsWith('activity') && !isFailureKey(key) && text !== undefined && text !== builtIn[key]
  )));
  if (!ownWording) return locale;
  let changed: ChatLocale | undefined;
  for (const key of FAILURE_KEYS) {
    if (own.some((table) => table[key] !== undefined) || locale[key] === STEP_FAILURE_TEXTS_EN[key]) continue;
    changed ??= { ...locale };
    changed[key] = STEP_FAILURE_TEXTS_EN[key];
  }
  return changed ?? locale;
}

/** The app's own value of `queueApprovalWaitingHint` (`locale`, else its `locales` tables), without built-ins. */
function explicitQueueApprovalHint(
  locale: Partial<ChatLocale> | undefined,
  locales: Readonly<Record<string, Partial<ChatLocale>>> | undefined,
  language: string | null,
): string | undefined {
  if (locale?.queueApprovalWaitingHint !== undefined) return locale.queueApprovalWaitingHint;
  if (!locales) return undefined;
  return resolveTextTable<Partial<ChatLocale>>({ requested: language ?? undefined, builtIn: { en: {} }, app: locales })
    .queueApprovalWaitingHint;
}

// ============================================================================
// Helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Coerce a row returned by `SessionConfig.load` into the SDK's
 * `ChatMessage` shape. Accepts either a full SDK message (already has
 * `parts`) or a flat `{ role, content }` wire message from a typical
 * REST backend. Rows with neither `parts` nor `content` are dropped.
 */
function coerceLoadedMessages(rows: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (Array.isArray(row.parts)) {
      result.push(row as unknown as ChatMessage);
      continue;
    }
    if (typeof row.content === 'string' && row.content.length > 0) {
      const role =
        row.role === 'assistant' || row.role === 'system' ? row.role : 'user';
      const createdAtRaw = row.createdAt ?? row.created_at;
      result.push({
        id: typeof row.id === 'string' ? row.id : `msg-${result.length}`,
        role,
        parts: [{ type: 'text', text: row.content }],
        createdAt: createdAtRaw ? new Date(createdAtRaw as string | number | Date) : undefined,
      });
    }
  }
  return result;
}

type MentionTrigger = string | null;

function getMentionTypesForTrigger(types: string[], trigger: MentionTrigger): string[] {
  if (trigger === '/') {
    const slashTypes = types.filter((t) => t === 'task' || t === 'command');
    return slashTypes.length > 0 ? slashTypes : types;
  }
  if (trigger === '@') {
    const atTypes = types.filter((t) => t !== 'command');
    return atTypes.length > 0 ? atTypes : types;
  }
  return types;
}

/** A message kept out of the transport (and so out of every request) but still shown and stored, after `afterId`. */
interface HeldMessage {
  message: ChatMessage;
  afterId: string | null;
}

/**
 * Remove orphaned tool calls (approval-requested without response)
 * from message history to prevent AI_MissingToolResultsError.
 *
 * `messages` is what the transport keeps and sends (unchanged since 0.19.0:
 * an assistant message without text and without a finished tool result is
 * left out). `held` are the left-out messages that still show a tool step
 * (a call a stop cut off, a failed or declined one): the chat keeps showing
 * and storing them, at their place, without sending them.
 */
function sanitizeMessages<T extends { id?: string; role: string; parts: unknown[] }>(
  msgs: T[],
): { messages: T[]; held: HeldMessage[] } {
  const held: HeldMessage[] = [];
  let previousId: string | null = null;
  const messages = msgs.map((message) => {
    if (message.role !== 'assistant') return message;

    const sanitizedParts = message.parts.filter((part) => {
      if (isRecord(part)) {
        const partType = typeof part.type === 'string' ? part.type : '';
        const partState = typeof part.state === 'string' ? part.state : '';
        if (partType.startsWith('tool-') && partState === 'approval-requested') {
          return false;
        }
      }
      return true;
    });

    // Same object when unchanged, so callers compare by identity, not by serializing file data.
    return sanitizedParts.length === message.parts.length ? message : { ...message, parts: sanitizedParts };
  }).filter((message) => {
    const afterId = previousId;
    // The anchor of a later held message: a message that is kept or held.
    if (typeof message.id === 'string') previousId = message.id;
    if (message.role === 'assistant') {
      const hasContent = message.parts.some((part) =>
        isRecord(part) && typeof part.text === 'string' &&
        (part.text as string).trim().length > 0
      );
      const hasToolOutput = message.parts.some((part) => {
        if (isRecord(part)) {
          const partType = typeof part.type === 'string' ? part.type : '';
          return partType.startsWith('tool-') && part.state === 'output-available';
        }
        return false;
      });
      const kept = hasContent || hasToolOutput || message.parts.length === 0;
      if (!kept && typeof message.id === 'string' && message.parts.some((part) => (
        isRecord(part) && typeof part.type === 'string' && part.type.startsWith('tool-')
      ))) {
        held.push({ message: message as unknown as ChatMessage, afterId });
      } else if (!kept) {
        previousId = afterId;
      }
      return kept;
    }
    return true;
  }) as T[];
  return { messages, held };
}

/** The transport's messages with the held ones back at their place; a held message whose anchor is gone is dropped. */
function withHeldMessages(messages: ChatMessage[], held: ReadonlyArray<HeldMessage>): ChatMessage[] {
  if (held.length === 0) return messages;
  const result: ChatMessage[] = [];
  const pending = held.filter((entry) => !messages.some((message) => message.id === entry.message.id));
  const place = (afterId: string | null) => {
    for (const entry of pending) {
      if (entry.afterId !== afterId || result.includes(entry.message)) continue;
      result.push(entry.message);
      place(entry.message.id);
    }
  };
  place(null);
  for (const message of messages) {
    result.push(message);
    place(message.id);
  }
  return result;
}

/**
 * The one shape every `session.save` receives: the held messages back at their
 * place and each recorded turn outcome on its user message.
 */
function storedHistory(
  messages: ChatMessage[],
  held: ReadonlyArray<HeldMessage>,
  outcomes: ReadonlyMap<string, TurnOutcome>,
): ChatMessage[] {
  return withStoredTurnOutcomes(withHeldMessages(messages, held), outcomes);
}

/**
 * Merge consecutive assistant messages by keeping only the last one in each run.
 *
 * When a pipeline resumes after approval, `useChat` creates a new assistant
 * message for each server response. The AI model regenerates cumulative text
 * (all prior context + new content), resulting in multiple bubbles with
 * progressively longer duplicate text.
 *
 * By keeping only the last message in each consecutive assistant run, we show
 * only the most complete version. Tool result processing and suggestion
 * extraction operate on `rawMessages` independently, so no data is lost.
 */
function consolidateAssistantMessages<T extends { role: string }>(messages: T[]): T[] {
  if (messages.length <= 1) return messages;

  const result: T[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    // Check if this assistant message is followed by another assistant message
    // (without a user message in between). If so, it's intermediate — skip it.
    let isIntermediate = false;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') break;
      if (messages[j].role === 'assistant') {
        isIntermediate = true;
        break;
      }
    }

    if (!isIntermediate) {
      result.push(msg);
    }
  }

  return result;
}

function normalizePipelineStepReport(data: unknown): PipelineStepReport | null {
  if (!isRecord(data)) return null;
  if (typeof data.stepNumber !== 'number' || !Number.isFinite(data.stepNumber)) {
    return null;
  }
  const stepNumber = Math.max(0, Math.floor(data.stepNumber));
  const toolCalls = Array.isArray(data.toolCalls)
    ? data.toolCalls.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const toolResults = typeof data.toolResults === 'number' && Number.isFinite(data.toolResults)
    ? Math.max(0, Math.floor(data.toolResults))
    : 0;
  const pendingApprovals = typeof data.pendingApprovals === 'number' && Number.isFinite(data.pendingApprovals)
    ? Math.max(0, Math.floor(data.pendingApprovals))
    : Math.max(toolCalls.length - toolResults, 0);
  const usage = isRecord(data.usage) ? data.usage : {};

  return {
    stepNumber,
    finishReason: typeof data.finishReason === 'string' ? data.finishReason : 'other',
    toolCalls,
    toolResults,
    requiresApproval: data.requiresApproval === true || pendingApprovals > 0,
    pendingApprovals,
    summary: typeof data.summary === 'string' ? data.summary : `Step ${stepNumber + 1}`,
    usage: {
      inputTokens: typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
        ? usage.inputTokens
        : 0,
      outputTokens: typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
        ? usage.outputTokens
        : 0,
      totalTokens: typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
        ? usage.totalTokens
        : 0,
    },
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
  };
}

function normalizePipelineState(data: unknown): PipelineState | null {
  if (!isRecord(data)) return null;
  if (
    data.status !== 'running' &&
    data.status !== 'completed' &&
    data.status !== 'safety-stop' &&
    data.status !== 'aborted' &&
    data.status !== 'error'
  ) {
    return null;
  }
  if (typeof data.maxSteps !== 'number' || !Number.isFinite(data.maxSteps)) {
    return null;
  }
  if (
    data.stepLimitSource !== 'explicit' &&
    data.stepLimitSource !== 'module' &&
    data.stepLimitSource !== 'safety' &&
    data.stepLimitSource !== 'runtime-budget'
  ) {
    return null;
  }

  return {
    status: data.status,
    totalSteps: typeof data.totalSteps === 'number' && Number.isFinite(data.totalSteps)
      ? Math.max(0, Math.floor(data.totalSteps))
      : 0,
    finishReason: typeof data.finishReason === 'string' ? data.finishReason : undefined,
    maxSteps: Math.max(1, Math.floor(data.maxSteps)),
    stepLimitSource: data.stepLimitSource,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    message: typeof data.message === 'string' ? data.message : undefined,
  };
}

// ============================================================================
// Provider Component
// ============================================================================

export interface AiChatProviderProps extends AiChatProviderConfig {
  /**
   * Chat transport — required. Use one of the built-in hooks or implement
   * the `ChatTransport` interface for a custom backend.
   *
   * - `useVercelAiChatTransport` from `glirastes/react/vercel`
   * - `useLangGraphChatTransport` from `glirastes/react/langgraph`
   */
  transport: ChatTransport;
  children: ReactNode;
}

/** Longest the chat waits for `session.save` before a UI action loads the next page. */
const PAGE_LOAD_SAVE_TIMEOUT_MS = 500;

/** Turns this page continued after a page load, by the ids of their results (also across providers). */
const CONTINUED_TURNS = new Set<string>();

/**
 * A result with generated UI actions that already carries the browser's
 * `outcome` object: it ran before and never runs again. Other tools may have
 * an `outcome` field of their own.
 */
function carriesUiOutcome(output: Record<string, unknown>): boolean {
  return isRecord(output.outcome) && toolResultUiActions(output).length > 0;
}

/**
 * True when `messages` continue the messages a request started from: the
 * same ids in order (a trailing assistant message may be replaced, as a
 * regenerated answer is). Results of a history the host set while the
 * request ran (another chat, another tab) do not count as this request's.
 */
function continuesRequestBase(
  messages: ReadonlyArray<{ id: string }>,
  base: ReadonlyArray<{ id: string; role: string }>,
): boolean {
  const kept = base.at(-1)?.role === 'assistant' ? base.length - 1 : base.length;
  if (messages.length < kept) return false;
  for (let index = 0; index < kept; index += 1) {
    if (messages[index]?.id !== base[index]!.id) return false;
  }
  return true;
}

/** A message after commands, mentions, `onBeforeSend` and the clarification answer. */
type PreparedSend =
  | { kind: 'needs-args'; request: PendingChatCommand }
  | { kind: 'command'; text: string }
  | { kind: 'message'; text: string; files?: FilePart[] };

/** How long the queue waits after an answered approval for the transport to send it on by itself. */
const APPROVAL_RESEND_GRACE_MS = 1500;

/** An assistant message of the turn the user message started (up to the next user message) asks for an approval. */
function turnAwaitsApproval(messages: ReadonlyArray<{ id?: string; role: string; parts: ReadonlyArray<unknown> }>, userMessageId: string): boolean {
  const start = messages.findIndex((message) => message.role === 'user' && message.id === userMessageId);
  if (start < 0) return false;
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'user') return false;
    if (message.role === 'assistant' && message.parts.some((part) => isRecord(part) && part.state === 'approval-requested')) return true;
  }
  return false;
}

/** The last assistant message still asks for an approval (before the approval map has it). */
function lastStepAwaitsApproval(messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return false;
  return last.parts.some((part) => isRecord(part) && part.state === 'approval-requested');
}

/**
 * Provider component that manages chat state and exposes it to child components.
 *
 * Transport-agnostic: pick a transport hook (Vercel, LangGraph, or your own)
 * and pass it via the `transport` prop.
 *
 * Features:
 * - Message sanitization (removes orphaned approval-requested tool parts)
 * - Session persistence (load on mount, save on change)
 * - Approval extraction and response handling
 * - Truncation detection via `data-truncation` data parts
 * - Suggestion extraction from `suggest_followups` tool output
 * - Pagination (visible message count, loadMore)
 *
 * @example
 * ```tsx
 * import { AiChatProvider, AiChatPanel } from 'glirastes/react';
 * import { useVercelAiChatTransport } from 'glirastes/react/vercel';
 *
 * function App() {
 *   const transport = useVercelAiChatTransport({ endpoint: '/api/ai/chat' });
 *   return (
 *     <AiChatProvider transport={transport}>
 *       <AiChatPanel />
 *     </AiChatProvider>
 *   );
 * }
 * ```
 */
const ACTIVITY_DETAILS = new Set<ActivityLogDetails>(['auto', 'results', 'all', 'none']);

export function AiChatProvider({
  transport,
  mentions,
  completionProviders,
  triggers: triggerDefinitions,
  composer: composerConfig,
  completionContext,
  onCompletionProviderError,
  onCompletionSelect,
  chatInteractions,
  entityLinks,
  markdown,
  onOpenRequest,
  toolRenderers,
  toolResults: userToolResults,
  activityLog: userActivityLog,
  attachments: userAttachments,
  voice: userVoice,
  session,
  classNames: userClassNames,
  components: userComponents,
  suggestions: userSuggestions,
  locale: userLocale,
  locales: userLocales,
  languageSource = 'page',
  language: userLanguage,
  sendLanguage = true,
  theme: userTheme,
  themeScope = 'inline',
  unstyled = false,
  onToolResult,
  uiActionBus,
  onUiActionOutcome,
  onTurnEnd,
  uiActionOutcomeTimeoutMs,
  uiActionOutcomes = true,
  onBeforeSend,
  approvalDescription: userApprovalDescription,
  approvalSubjects = true,
  approvalDisplay: userApprovalDisplay,
  entityDeclarations,
  continueMessage = 'Please continue.',
  queue: userQueue,
  toolLabels: userToolLabels,
  pipelineMessageTranslator,
  stepSummaryFormatter,
  children,
}: AiChatProviderProps) {
  // What the chat turn says about its tools (label per model name, app
  // language) and the language of the page: the defaults of a chat that
  // configures neither `locale`, `toolLabels` nor `approvalDescription`.
  const [toolPresentation, setToolPresentation] = useState<ToolPresentation | null>(null);
  /** Declared identity the server sent (`data-tool-entities`), merged with the app's own below. */
  const [streamedEntities, setStreamedEntities] = useState<EntityDeclarationsByTool | null>(null);
  const declarations = useMemo<EntityDeclarationsByTool | undefined>(() => {
    const merged = { ...(streamedEntities ?? {}), ...sanitizeEntityDeclarations(entityDeclarations) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [streamedEntities, entityDeclarations]);
  const declarationsRef = useRef(declarations);
  declarationsRef.current = declarations;
  const pageLanguage = usePageLanguage();
  // The app's stated language, else the page's (the UI the user reads), the server's tool wording only without one;
  // `languageSource: 'server'` keeps the order before 0.18.0.
  const statedLanguage = typeof userLanguage === 'string' && userLanguage.trim() !== '' ? userLanguage.trim() : null;
  const language = statedLanguage ?? (languageSource === 'server'
    ? toolPresentation?.locale ?? pageLanguage
    : pageLanguage ?? toolPresentation?.locale ?? null);
  // English defaults, then the built-in texts of the app's language, then the caller's overrides.
  // With `locales`, per key in the language's fallback order (the app's table before the built-in one).
  const locale = useMemo<ChatLocale>(() => withFailureTextsOfOwnWording(withQueueApprovalHint(
    userLocales
      ? {
        ...resolveTextTable<ChatLocale>({
          requested: language ?? undefined,
          builtIn: { en: DEFAULT_LOCALE, de: { ...DEFAULT_LOCALE, ...deChatLocale } },
          app: userLocales,
        }),
        ...(userLocale ?? {}),
      }
      : { ...DEFAULT_LOCALE, ...languageLocale(language), ...(userLocale ?? {}) },
    explicitQueueApprovalHint(userLocale, userLocales, language),
  ), userLocale, userLocales, language, statedLanguage !== null), [userLocale, userLocales, language, statedLanguage]);
  // Resolve `theme` prop → CSS variables spread onto widget roots.
  const themeVars = useMemo<CSSProperties>(
    () => (themeScope === 'inherit' || unstyled ? {} : getThemeVars(userTheme)) as CSSProperties,
    [userTheme, themeScope, unstyled],
  );
  const themeEffect = useMemo(() => getThemeEffect(userTheme), [userTheme]);
  const classNames = useMemo(() => userClassNames ?? {}, [userClassNames]);
  const components = useMemo(() => userComponents ?? {}, [userComponents]);
  const suggestionsConfig = useMemo(
    () => ({ enabled: true, count: 3, autoSuggest: true, ...userSuggestions }),
    [userSuggestions],
  );
  const toolResultConfig = useMemo(
    () => resolveToolResultConfig(userToolResults, Boolean(toolRenderers && toolRenderers.length > 0)),
    [userToolResults, toolRenderers],
  );
  // Keyed on the fields, so an inline `activityLog={{ … }}` does not re-render every message.
  const activityExpandWhileRunning = userActivityLog?.expandWhileRunning === true;
  const activityRunningProgress = userActivityLog?.runningProgress === true;
  const activityNoticePlacement = userActivityLog?.noticePlacement === 'message' ? 'message' : 'log';
  const activityDetails = ACTIVITY_DETAILS.has(userActivityLog?.details as ActivityLogDetails)
    ? userActivityLog!.details!
    : 'auto';
  const activityGrouping = userActivityLog?.grouping === 'sections' ? 'sections' : 'message';
  const activityNoticeScope = userActivityLog?.noticeScope === 'latest' ? 'latest' : 'every';
  const activityLogConfig = useMemo<Required<ActivityLogConfig>>(() => ({
    expandWhileRunning: activityExpandWhileRunning,
    runningProgress: activityRunningProgress,
    noticePlacement: activityNoticePlacement,
    details: activityDetails,
    grouping: activityGrouping,
    noticeScope: activityNoticeScope,
  }), [activityExpandWhileRunning, activityRunningProgress, activityNoticePlacement, activityDetails, activityGrouping,
    activityNoticeScope]);
  const toolRendererRegistry = useMemo(
    () => (toolRenderers && toolRenderers.length > 0
      ? createToolResultRendererRegistry(toolRenderers)
      : undefined),
    [toolRenderers],
  );
  const attachmentOptions = useMemo(() => resolveAttachmentOptions(userAttachments), [userAttachments]);
  const voiceConfig = useMemo(
    () => ({
      enabled: false,
      language: 'de',
      recordingBar: { enabled: true, variant: 'inline' as const, ...(userVoice?.recordingBar ?? {}) },
      ...userVoice,
    }),
    [userVoice],
  );
  // The labels of the turn's tools, each used for one call and for several; the caller's labels win.
  const toolLabels = useMemo<ToolLabelConfig>(() => ({
    labels: {
      ...Object.fromEntries(Object.entries(toolPresentation?.labels ?? {})
        .map(([name, label]) => [name, { singular: label, plural: label }])),
      ...(userToolLabels?.labels ?? {}),
    },
  }), [toolPresentation, userToolLabels]);

  // Without the app's own description, an approval names the action by its
  // label and lists what the call states, instead of the raw tool name alone.
  const derivedApprovalDescription = useMemo<ApprovalDescriptionFn>(() => {
    const actions = Object.fromEntries(Object.entries(toolLabels.labels ?? {})
      .map(([name, label]) => [name, label.singular]));
    const describe = createApprovalDescriptionGenerator({ toolLabels: actions, dateLocale: language ?? 'en-US' });
    return (toolName, approvalId, args, context) => {
      const pending = describe(toolName, approvalId, args, context);
      return actions[toolName] ? pending : { ...pending, description: toolName };
    };
  }, [toolLabels, language]);
  const approvalDescriptionFn = userApprovalDescription ?? derivedApprovalDescription;
  // Keyed on the fields, so an inline `approvalDisplay={{ … }}` does not re-render every message.
  const approvalDecided = userApprovalDisplay?.decided === 'entry' ? 'entry' : 'none';
  const approvalOpen = userApprovalDisplay?.open === 'inline' ? 'inline' : 'panel';
  const approvalDisplayConfig = useMemo<Required<ApprovalDisplayConfig>>(
    () => ({ decided: approvalDecided, open: approvalOpen }),
    [approvalDecided, approvalOpen],
  );

  // Approvals state (Map for O(1) lookup)
  const [pendingApprovalsMap, setPendingApprovalsMap] = useState<Map<string, PendingApproval>>(new Map());
  // Set when the user sends while an approval waits; cleared once none waits.
  const [approvalReminder, setApprovalReminder] = useState(false);
  useEffect(() => {
    if (pendingApprovalsMap.size === 0) setApprovalReminder(false);
  }, [pendingApprovalsMap]);
  const [processingApprovalIds, setProcessingApprovalIds] = useState<Set<string>>(new Set());
  // Approved in this chat, no request started since: the automatic resend is still to come.
  const [resendApprovalIds, setResendApprovalIds] = useState<ReadonlySet<string>>(new Set());
  const [approvalError, setApprovalError] = useState<Error | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  // A completed load belongs to one session, not to the provider forever.
  // Otherwise a render with a new id can persist the previous session's rows.
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const [sessionLoadFailure, setSessionLoadFailure] = useState<{ id: string; error: Error } | null>(null);
  const [sessionRestoreAttempt, setSessionRestoreAttempt] = useState(0);
  const [isSessionMutating, setIsSessionMutating] = useState(false);
  const sessionMutationRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Multi-session state
  //
  // `session.activeId` is the controlled form — when the drop-in widget owns
  // the id (so it can feed it to the transport as `threadId`). Otherwise we
  // fall back to an internal `uncontrolledActiveId`, seeded from
  // `defaultActiveId` / `'default'`.
  // ---------------------------------------------------------------------------
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState<string>(
    () => session?.activeId ?? session?.defaultActiveId ?? 'default',
  );
  const activeSessionId = session?.activeId ?? uncontrolledActiveId;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const isBootstrapSentinel = activeSessionId === 'default'
    && session?.list !== undefined && session.defaultActiveId === undefined
    && session.activeId === undefined && !sessions.some((entry) => entry.id === 'default');
  const [isSessionsLoading, setIsSessionsLoading] = useState(false);

  const sessionsSupported = Boolean(
    session && session.list && session.create && session.remove,
  );

  // Keep a ref so callbacks inside effects read the current session config
  // without re-binding on every render.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Message queue (`queue`): off by default; without it nothing below changes.
  const queueConfig = useResolvedQueueConfig(userQueue);
  const queueEnabled = queueConfig.enabled;
  const queueEnabledRef = useRef(queueEnabled);
  queueEnabledRef.current = queueEnabled;
  const queueStore = useMessageQueueStore(userQueue, queueEnabled, activeSessionId);
  // A send of this chat (direct or from the queue) whose request has not ended yet.
  const sendInFlightRef = useRef(false);
  // `sendNow` with `'abort'` stopped the run: that stop does not pause the queue.
  const selfAbortRef = useRef(false);
  // UI actions and page-load continuations still running (queue only): the queue waits for them.
  const pendingUiWorkRef = useRef(0);
  const [pendingUiWork, setPendingUiWork] = useState(0);
  const trackUiWork = useCallback(() => {
    pendingUiWorkRef.current += 1;
    setPendingUiWork(pendingUiWorkRef.current);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // One tick later: the transport has started a continuation by then.
      setTimeout(() => {
        pendingUiWorkRef.current = Math.max(0, pendingUiWorkRef.current - 1);
        if (mountedRef.current) setPendingUiWork(pendingUiWorkRef.current);
      }, 0);
    };
  }, []);

  // Truncation
  const [truncation, setTruncation] = useState<TruncationInfo | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepReport[]>([]);
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  // How each turn ended, keyed by the user message that started it; stored with the history.
  const [turnOutcomes, setTurnOutcomes] = useState<ReadonlyMap<string, TurnOutcome>>(() => new Map());
  // Messages left out of the transport before a send (as in 0.19.0) that still show a step: shown and stored, never sent.
  const [heldMessages, setHeldMessages] = useState<ReadonlyArray<HeldMessage>>([]);
  // For a save outside a render (the page-load save): the same state the save on change uses.
  const heldMessagesRef = useRef(heldMessages);
  heldMessagesRef.current = heldMessages;
  const turnOutcomesRef = useRef(turnOutcomes);
  turnOutcomesRef.current = turnOutcomes;
  // The chat (the session whose history the transport held) and the user message the running or last
  // request was started for, taken when it started: its outcome goes there, not to whatever is open now.
  // `null` ids: the request belongs to nothing that is shown (cleared meanwhile, or started while a chat loaded).
  const requestTurnRef = useRef<{ sessionId: string | null; userMessageId: string | null } | null>(null);
  // Outcomes of requests that ended while another chat was open, per session: they join that chat's
  // history when it loads in this provider again (and are stored with it then). Lost on a page load.
  const leftChatOutcomesRef = useRef(new Map<string, ReadonlyMap<string, TurnOutcome>>());
  const loadedSessionIdRef = useRef(loadedSessionId);
  loadedSessionIdRef.current = loadedSessionId;
  // `onTurnEnd`: outcomes of the open chat recorded live and not reported yet (with the status and reason
  // they were recorded with), and the ones whose state update is not applied yet. Restored outcomes never get here.
  const turnEndPendingRef = useRef(new Map<string, { sessionId: string; status: TurnOutcome['status']; reason: TurnOutcomeReason }>());
  const turnEndQueuedRef = useRef(new Set<string>());
  const onTurnEndRef = useRef(onTurnEnd);
  onTurnEndRef.current = onTurnEnd;
  const [, setTurnEndCheck] = useState(0);
  /** Where the outcome of the running or last request goes, and whether that chat is the one open. */
  const requestTurn = useCallback(() => {
    const bound = requestTurnRef.current ?? {
      // A request never seen running (it ended in the render it started): the open chat's latest turn.
      sessionId: loadedSessionIdRef.current,
      userMessageId: latestUserMessageId(rawMessagesRef.current as unknown as ChatMessage[]),
    };
    if (bound.sessionId === null || bound.userMessageId === null) return null;
    const open = bound.sessionId === activeSessionIdRef.current && bound.sessionId === loadedSessionIdRef.current;
    return { sessionId: bound.sessionId, userMessageId: bound.userMessageId, open };
  }, []);
  /**
   * Records how the turn of the running or last request ended (see `requestTurn`). A later report of the same
   * status keeps the first; `onlyIfNone` (a run that ended by itself) never replaces a stop or failure recorded
   * during the run.
   */
  const recordTurnOutcome = useCallback((status: TurnOutcome['status'], reason: TurnOutcomeReason, onlyIfNone = false) => {
    const target = requestTurn();
    if (!target) return;
    const { userMessageId } = target;
    const apply = (prev: ReadonlyMap<string, TurnOutcome>, notify = false) => {
      if (notify) turnEndQueuedRef.current.delete(userMessageId);
      const current = prev.get(userMessageId);
      if (current?.status === status || (onlyIfNone && current)) return prev;
      const next = new Map(prev);
      next.set(userMessageId, { userMessageId, status, reason, at: new Date().toISOString() });
      // A change of the open chat's outcome: `onTurnEnd` reports it once the turn is over (idempotent, so a
      // StrictMode double call of this updater sets the same entry).
      if (notify) turnEndPendingRef.current.set(userMessageId, { sessionId: target.sessionId, status, reason });
      return next;
    };
    if (target.open) {
      // Until this update is applied, the outcome in state may still change: no report before.
      turnEndQueuedRef.current.add(userMessageId);
      setTurnOutcomes((prev) => apply(prev, true));
      return;
    }
    const left = leftChatOutcomesRef.current;
    left.set(target.sessionId, apply(left.get(target.sessionId) ?? new Map()));
  }, [requestTurn]);

  // Pagination
  const [visibleMessageCount, setVisibleMessageCount] = useState(30);

  // Suggestions
  const [suggestionChips, setSuggestionChips] = useState<string[]>(
    suggestionsConfig.staticChips ?? [],
  );
  const isSuggestionsGenerating = false; // Suggestions come from tool output, not async generation

  // Mentions
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger>(null);
  const [mentionResults, setMentionResults] = useState<MentionResult[]>([]);
  const [activeMentions, setActiveMentions] = useState<MentionData[]>([]);
  const [isMentionSearching, setIsMentionSearching] = useState(false);

  const onCompletionProviderErrorRef = useRef(onCompletionProviderError);
  onCompletionProviderErrorRef.current = onCompletionProviderError;
  // Declarative `@` entities and `/` commands join the app's own providers.
  const interactionRegistry = useMemo(
    () => (chatInteractions
      ? createChatInteractionRegistry({ ...chatInteractions, context: completionContext })
      : undefined),
    [chatInteractions, completionContext],
  );
  const allCompletionProviders = useMemo(
    () => [...(completionProviders ?? []), ...(interactionRegistry?.providers ?? [])],
    [completionProviders, interactionRegistry],
  );
  // Throws on an invalid or duplicate definition, so a bad config fails at once.
  const triggers = useMemo(
    () => resolveChatTriggers(triggerDefinitions, allCompletionProviders),
    [triggerDefinitions, allCompletionProviders],
  );
  const entityPrefix = triggers.find((trigger) => trigger.char === '@')?.prefix ?? '@';
  const mentionPrefix = useMemo(() => createMentionPrefixLookup(triggers), [triggers]);
  // Drafts live as long as this provider: an identity change remounts it and starts empty.
  const draftsRef = useRef<ComposerDraftController | null>(null);
  if (!draftsRef.current) draftsRef.current = createComposerDraftController();
  const drafts = draftsRef.current;
  // What `session.save` gets as its third argument: only when a trigger claims `types`, so saves stay as before otherwise.
  const saveOptionsRef = useRef<{ mentionPrefix: (type: string) => string } | undefined>(undefined);
  saveOptionsRef.current = mentionPrefix === inferMentionPrefix ? undefined : { mentionPrefix };
  const completionSearch = useMemo(
    () => (allCompletionProviders.length > 0
      ? createCompletionSearch(allCompletionProviders, {
        context: completionContext,
        onProviderError: (providerId, error) =>
          onCompletionProviderErrorRef.current?.(providerId, error),
      })
      : undefined),
    [allCompletionProviders, completionContext],
  );
  const [pendingCommand, setPendingCommand] = useState<PendingChatCommand | null>(null);
  const [composerMentions, setComposerMentions] = useState<MentionData[]>([]);

  // Refs for deduplication
  const processedToolCallsRef = useRef<Set<string>>(new Set());
  const handledApprovalIdsRef = useRef<Set<string>>(new Set());
  // UI actions run one tool result after another, in call order.
  const uiActionQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Set once a UI action started a full page load: nothing after it runs in this document, also not after a reset.
  const pageLeavingRef = useRef(false);
  // Live results held back until the earlier calls of their message have results.
  const deferredResultsRef = useRef<Map<string, {
    toolName: string;
    output: Record<string, unknown>;
    messageId: string;
  }>>(new Map());
  // Aborted with each reset so a running result stops before its next action.
  const uiActionAbortRef = useRef(new AbortController());
  // Whether the previous run of the tool-result effect saw a request of this instance running.
  const liveRequestRef = useRef(false);
  // A request that was running when the chat was reset: its later results belong to the left chat.
  const staleRequestRef = useRef(false);
  // Message ids when the running request started; a history set meanwhile does not continue them.
  const requestBaseRef = useRef<Array<{ id: string; role: string }>>([]);
  // Bumped by clear(), a session switch and unmount: queued actions of the left chat never start.
  const uiActionGenerationRef = useRef(0);
  const resetUiActions = useCallback(() => {
    uiActionGenerationRef.current += 1;
    uiActionAbortRef.current.abort();
    uiActionAbortRef.current = new AbortController();
    // A request still running now delivers to the left chat.
    staleRequestRef.current = streamActiveRef.current;
    liveRequestRef.current = false;
    uiActionQueueRef.current = Promise.resolve();
    deferredResultsRef.current.clear();
  }, []);
  // Unmount drops queued actions; StrictMode's immediate remount keeps them
  // (and the running request), so only a provider that stays unmounted resets.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        uiActionGenerationRef.current += 1;
        uiActionAbortRef.current.abort();
        uiActionQueueRef.current = Promise.resolve();
      });
    };
  }, []);


  // Stable refs for callbacks to avoid re-creating transport
  const onToolResultRef = useRef(onToolResult);
  onToolResultRef.current = onToolResult;
  const uiActionBusRef = useRef(uiActionBus);
  uiActionBusRef.current = uiActionBus;
  const onUiActionOutcomeRef = useRef(onUiActionOutcome);
  onUiActionOutcomeRef.current = onUiActionOutcome;
  const uiActionOutcomeTimeoutRef = useRef(uiActionOutcomeTimeoutMs);
  uiActionOutcomeTimeoutRef.current = uiActionOutcomeTimeoutMs;
  const approvalDescriptionRef = useRef(approvalDescriptionFn);
  approvalDescriptionRef.current = approvalDescriptionFn;
  const approvalSubjectsRef = useRef(approvalSubjects);
  approvalSubjectsRef.current = approvalSubjects;
  const languageRef = useRef(language);
  languageRef.current = language;

  // Data part handler — processes pipeline and truncation events from any transport
  const handleDataPart = useCallback((dataPart: { type: string; data: unknown }) => {
    if (dataPart.type === 'data-tool-entities') {
      const data = dataPart.data as { tools?: unknown } | null;
      const next = sanitizeEntityDeclarations(data?.tools);
      setStreamedEntities((current) => (JSON.stringify(current ?? {}) === JSON.stringify(next) ? current : next));
      return;
    }
    if (dataPart.type === 'data-tool-presentation') {
      const next = parseToolPresentation(dataPart.data);
      // Every turn sends it again; keep the object while its content is the same.
      if (next) setToolPresentation((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      return;
    }
    if (dataPart.type === 'data-truncation') {
      const data = dataPart.data as { completedTools: string[]; message: string };
      setTruncation({
        completedTools: data.completedTools,
        message: data.message,
      });
      return;
    }

    if (dataPart.type === 'data-step-report') {
      const report = normalizePipelineStepReport(dataPart.data);
      if (!report) return;

      setPipelineSteps((prev) => mergePipelineSteps(prev, [report]));
      setPipelineState((prev) => prev ?? {
        status: 'running',
        totalSteps: report.stepNumber + 1,
        maxSteps: 1,
        stepLimitSource: 'safety',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (dataPart.type === 'data-pipeline-state') {
      const nextState = normalizePipelineState(dataPart.data);
      if (nextState) {
        setPipelineState(nextState);
        // A request of a chat that was left reports to that chat (`recordTurnOutcome`), not to the latest turn here.
        if (nextState.status === 'aborted' || nextState.status === 'error' || nextState.status === 'safety-stop') {
          recordTurnOutcome(nextState.status, 'pipeline');
        }
      }
    }
  }, [recordTurnOutcome]);

  const resolvedTransport = transport;

  useEffect(() => {
    return resolvedTransport.subscribeToData?.(handleDataPart);
  }, [resolvedTransport, handleDataPart]);

  const {
    messages: rawMessages,
    sendMessage,
    status,
    error: transportError,
    stop: transportStop,
    setMessages,
    addToolApprovalResponse,
  } = resolvedTransport;

  const isLoading = status === 'submitted' || status === 'streaming';
  const streamActiveRef = useRef(isLoading);
  streamActiveRef.current = isLoading;
  const sessionNotReady = Boolean(session?.load && loadedSessionId !== activeSessionId);

  // ---------------------------------------------------------------------------
  // Outcome protocol: write each marked result's outcome through the transport.
  // ---------------------------------------------------------------------------
  const transportRef = useRef(resolvedTransport);
  transportRef.current = resolvedTransport;
  const rawMessagesRef = useRef(rawMessages);
  rawMessagesRef.current = rawMessages;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const attachmentStore = session?.attachments ?? null;
  // Messages of a previous chat stay in the transport until the new one has loaded.
  const attachmentMessagesReadyRef = useRef(true);
  attachmentMessagesReadyRef.current = !sessionNotReady;
  useEffect(() => {
    const source = {
      conversationId: activeSessionId,
      messages: () => (attachmentMessagesReadyRef.current ? (rawMessagesRef.current as unknown as ChatMessage[]) : []),
      store: attachmentStore,
    };
    setActiveChatAttachmentSource(source);
    return () => clearChatAttachmentSource(source);
  }, [activeSessionId, attachmentStore]);
  const reportsUiOutcomes = uiActionOutcomes !== false && typeof resolvedTransport.addToolOutput === 'function';
  const reportsUiOutcomesRef = useRef(reportsUiOutcomes);
  reportsUiOutcomesRef.current = reportsUiOutcomes;
  // The chat language each request names (`sendLanguage`): the app's or the page's, never the server's own echo.
  const requestLanguage = sendLanguage !== false && languageSource !== 'server' ? statedLanguage ?? pageLanguage : null;
  const setRequestLanguage = resolvedTransport.setRequestLanguage;
  useEffect(() => {
    if (!setRequestLanguage) return undefined;
    setRequestLanguage(requestLanguage);
    return () => setRequestLanguage(null);
  }, [setRequestLanguage, requestLanguage]);
  const setUiOutcomeReporting = resolvedTransport.setUiOutcomeReporting;
  useEffect(() => {
    if (!setUiOutcomeReporting) return undefined;
    setUiOutcomeReporting(reportsUiOutcomes);
    return () => setUiOutcomeReporting(false);
  }, [setUiOutcomeReporting, reportsUiOutcomes]);
  // The outcome written per tool call id, so a result is reported once (again only with another code).
  const reportedOutcomesRef = useRef<Map<string, UiOutcome>>(new Map());
  // The result whose actions run right now, for a page load that starts during it.
  const currentUiRunRef = useRef<{ toolName: string; toolCallId: string; output: Record<string, unknown> } | null>(null);
  // Results that wait for their outcome before the model answers: the composer stays locked meanwhile.
  const [awaitedOutcomes, setAwaitedOutcomes] = useState(0);
  // A page load a reloading bridge prepares for the running result, until its push settled.
  const pageLoadRef = useRef<{
    toolCallId: string;
    action: UiAction;
    done: Promise<UiActionPageLoadResult>;
    resolve: (result: UiActionPageLoadResult) => void;
  } | null>(null);
  // The session whose history was just loaded, until the page-load continuation was checked.
  const loadedHistoryRef = useRef<string | null>(null);

  /**
   * Writes the outcome into a marked result through the transport and
   * resolves it once written (also when the same outcome was written
   * before); undefined when the result is not marked, the chat does not
   * report, the result is no longer in the last message (a new message
   * followed it: `addToolOutput` reaches only the last one) or writing failed.
   */
  const reportUiOutcome = useCallback(async (
    toolName: string,
    toolCallId: string,
    output: Record<string, unknown>,
    code: UiActionRunCode,
  ): Promise<UiOutcome | undefined> => {
    if (typeof output.awaitsOutcome !== 'boolean' || !reportsUiOutcomesRef.current) return undefined;
    const write = transportRef.current.addToolOutput;
    if (typeof write !== 'function') return undefined;
    const outcome: UiOutcome = code === 'timeout' || code === 'unconfirmed'
      ? { v: 1 }
      : code === 'initiated' ? { v: 1, code, at: Date.now() } : { v: 1, code };
    const earlier = reportedOutcomesRef.current.get(toolCallId);
    if (earlier && earlier.code === outcome.code) return earlier;
    const last = rawMessagesRef.current.at(-1);
    const inLast = last?.role === 'assistant'
      && last.parts.some((part) => (part as { toolCallId?: unknown }).toolCallId === toolCallId);
    if (!inLast) return undefined;
    reportedOutcomesRef.current.set(toolCallId, outcome);
    try {
      await write.call(transportRef.current, { tool: toolName, toolCallId, output: { ...output, outcome } });
      return outcome;
    } catch {
      if (reportedOutcomesRef.current.get(toolCallId) === outcome) {
        if (earlier) reportedOutcomesRef.current.set(toolCallId, earlier);
        else reportedOutcomesRef.current.delete(toolCallId);
      }
      console.warn('[glirastes] A UI action outcome could not be written');
      return undefined;
    }
  }, []);

  /**
   * The page is about to be left for the running result: it is `initiated`,
   * and every other result of the message still waiting for its outcome is
   * cut off ("not confirmed", it never runs later). Writes them and saves
   * the history with them in place now.
   */
  const settleForPageLoad = useCallback(async (
    current: { toolName: string; toolCallId: string; output: Record<string, unknown> },
    waitForStep: boolean,
    code: 'initiated' | 'unconfirmed' = 'initiated',
  ) => {
    const initiated = await reportUiOutcome(current.toolName, current.toolCallId, current.output, code);
    if (!initiated) return;
    // The other results of the step may still arrive: hold the page load until the stream ended.
    if (waitForStep) {
      // Within the bridge's own deadline, so the save below still lands before it loads the page.
      const deadline = Date.now() + Math.min(
        uiActionOutcomeTimeoutRef.current ?? UI_ACTION_OUTCOME_TIMEOUT_MS,
        BEFORE_PAGE_LOAD_TIMEOUT_MS - PAGE_LOAD_SAVE_TIMEOUT_MS - 300,
      );
      while (streamActiveRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // One more render, so the last results are in the messages.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Cut off only in the saved copy: should the page stay (the bridge refused), they still run here.
    const outcomes = new Map<string, UiOutcome>([[current.toolCallId, initiated]]);
    const last = rawMessagesRef.current.at(-1);
    for (const part of last?.role === 'assistant' ? last.parts : []) {
      const toolPart = part as { toolCallId?: unknown; output?: unknown };
      if (typeof toolPart.toolCallId !== 'string' || toolPart.toolCallId === current.toolCallId) continue;
      if (!isRecord(toolPart.output) || toolPart.output.awaitsOutcome !== true || toolPart.output.outcome !== undefined) continue;
      if (!reportedOutcomesRef.current.has(toolPart.toolCallId)) outcomes.set(toolPart.toolCallId, { v: 1 });
    }
    const save = sessionRef.current?.save;
    if (!save) return;
    const messages = rawMessagesRef.current.map((message, index, all) => (index !== all.length - 1 ? message : {
      ...message,
      parts: message.parts
        // A call whose result never reached this page is left out: the model never sees an
        // incomplete call either, and the turn can continue on the next page.
        .filter((part) => {
          const state = (part as { state?: unknown }).state;
          return state !== 'input-streaming' && state !== 'input-available';
        })
        .map((part) => {
          const toolPart = part as { toolCallId?: unknown; output?: unknown };
          const outcome = typeof toolPart.toolCallId === 'string' ? outcomes.get(toolPart.toolCallId) : undefined;
          return outcome && isRecord(toolPart.output) ? { ...part, output: { ...toolPart.output, outcome } } : part;
        }),
    })) as ChatMessage[];
    // The same shape as every other save (a page that goes may not render again).
    const history = storedHistory(messages, heldMessagesRef.current, turnOutcomesRef.current);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve(saveOptionsRef.current
        ? save(activeSessionIdRef.current, history, saveOptionsRef.current)
        : save(activeSessionIdRef.current, history)),
      new Promise((resolve) => { timer = setTimeout(resolve, PAGE_LOAD_SAVE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
  }, [reportUiOutcome]);

  // A reloading bridge (registerDocumentNavigation, `reloads`) waits for this
  // before it loads the next page. Only the chat whose running result the
  // navigation belongs to answers it.
  useEffect(() => onBeforeUiActionPageLoad(async (action) => {
    const current = currentUiRunRef.current;
    if (!current) return;
    const actions = toolResultUiActions(current.output);
    const href = isRecord(action.payload) ? action.payload.href : undefined;
    const ours = actions.includes(action)
      // A page-bound action first opens its route through a navigation of its own.
      || (action.type === 'glirastes.navigate' && actions.some((candidate) => candidate.route === href));
    if (!ours) return;
    let resolve!: (result: UiActionPageLoadResult) => void;
    const done = new Promise<UiActionPageLoadResult>((settle) => { resolve = settle; });
    pageLoadRef.current = { toolCallId: current.toolCallId, action, done, resolve };
    const generation = uiActionGenerationRef.current;
    const { signal } = uiActionAbortRef.current;
    await settleForPageLoad(current, true);
    // Reset (cleared, another session, unmounted) while preparing: the page must not be left for it.
    if (signal.aborted || uiActionGenerationRef.current !== generation || !mountedRef.current) return false;
    return undefined;
  }), [settleForPageLoad]);

  // What the bridge's push made of a page load this chat prepared.
  useEffect(() => onUiActionPageLoadResult((action, result) => {
    const pageLoad = pageLoadRef.current;
    if (pageLoad?.action === action) pageLoad.resolve(result);
  }), []);

  // A bridge that loads a page without saying so: the page goes while the action runs.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPageHide = () => {
      const current = currentUiRunRef.current;
      if (!current) return;
      pageLeavingRef.current = true;
      // Only a running navigation started this page load; any other action's fate is unknown.
      const navigates = toolResultUiActions(current.output).some((action) => (
        action.type === 'glirastes.navigate' || typeof action.route === 'string'
      ));
      void settleForPageLoad(current, false, navigates ? 'initiated' : 'unconfirmed').catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [settleForPageLoad]);
  const error = transportError ?? (sessionLoadFailure?.id === activeSessionId ? sessionLoadFailure.error : null);

  // A request that failed: its turn keeps the failure (also without an assistant message).
  useEffect(() => {
    if (transportError) recordTurnOutcome('error', 'request-failed');
  }, [transportError, recordTurnOutcome]);

  useEffect(() => {
    if (!error) return;
    setPipelineState((prev) => ({
      status: 'error',
      totalSteps: prev?.totalSteps ?? pipelineSteps.length,
      finishReason: 'error',
      maxSteps: prev?.maxSteps ?? 1,
      stepLimitSource: prev?.stepLimitSource ?? 'safety',
      updatedAt: new Date().toISOString(),
      message: 'Pipeline failed.',
    }));
  }, [error, pipelineSteps.length]);

  // Mark stored messages as already processed (prevents re-dispatching tool results)
  const markStoredMessagesAsProcessed = useCallback((storedMessages: unknown[]) => {
    for (const message of storedMessages) {
      if (!isRecord(message)) continue;
      const messageId = typeof message.id === 'string' ? message.id : 'stored-message';
      const parts = Array.isArray(message.parts) ? message.parts : [];

      for (const part of parts) {
        if (!isRecord(part)) continue;
        const partType = typeof part.type === 'string' ? part.type : '';

        if (partType.startsWith('tool-')) {
          const toolCallId = typeof part.toolCallId === 'string'
            ? part.toolCallId
            : `${messageId}-${partType}`;
          processedToolCallsRef.current.add(toolCallId);

          if (part.state === 'approval-requested' && isRecord(part.approval) && typeof part.approval.id === 'string') {
            handledApprovalIdsRef.current.add(part.approval.id);
          }

          if (part.state === 'output-available' && isRecord(part.output) && part.output.success && part.output.taskId) {
            processedToolCallsRef.current.add(`task-${toolCallId}`);
          }
        }
      }
    }
  }, []);

  // An open approval belongs to the chat that asked for it. A host that owns
  // the active id switches chats without switchSession(), so drop it here.
  const approvalSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (approvalSessionRef.current === activeSessionId) return;
    approvalSessionRef.current = activeSessionId;
    resetUiActions();
    setPendingApprovalsMap(new Map());
    // Held messages and a refused message belong to the chat that was left.
    setHeldMessages([]);
    setLastRejection(null);
  }, [activeSessionId, resetUiActions]);

  // Load messages from session whenever the active session changes.
  // Runs on mount and on every switchSession() call.
  useEffect(() => {
    const cfg = sessionRef.current;
    if (!cfg?.load) {
      setLoadedSessionId(activeSessionId);
      if (!isInitialized) setIsInitialized(true);
      return;
    }

    // Don't try to load the bootstrap sentinel when multi-session mode is
    // active — `'default'` is unlikely to be a valid session id in the
    // consumer's backend, and the auto-select effect (below) will switch
    // us to the first real session as soon as `list()` resolves.
    if (isBootstrapSentinel) {
      if (!isInitialized) setIsInitialized(true);
      return;
    }

    let cancelled = false;
    setLoadedSessionId(null);
    setSessionLoadFailure(null);
    setMessages([] as unknown as typeof rawMessages);
    setTurnOutcomes(new Map());
    // What the loaded history brings was not recorded now: nothing of it is reported.
    turnEndPendingRef.current.clear();
    setHeldMessages([]);

    (async () => {
      try {
        const loaded = await Promise.resolve(cfg.load!(activeSessionId));
        if (cancelled) return;
        processedToolCallsRef.current.clear();
        handledApprovalIdsRef.current.clear();
        // The transport may still have held the previous chat's messages
        // until now; an approval read from them is not this chat's.
        setPendingApprovalsMap(new Map());
        // Coerce wire-shape rows (with `content: string`) into SDK
        // messages (with `parts: [...]`) so bridges don't have to.
        const stored = readStoredTurnOutcomes(loaded ? coerceLoadedMessages(loaded as unknown[]) : []);
        const coerced = stored.messages;
        // A request of this chat that ended while another one was open: its outcome joins the turn it was for.
        const left = leftChatOutcomesRef.current.get(activeSessionId);
        leftChatOutcomesRef.current.delete(activeSessionId);
        let outcomes: ReadonlyMap<string, TurnOutcome> = stored.outcomes;
        for (const [userMessageId, outcome] of left ?? []) {
          if (!coerced.some((message) => message.id === userMessageId && message.role === 'user')) continue;
          outcomes = new Map(outcomes).set(userMessageId, outcome);
        }
        setTurnOutcomes(outcomes);
        if (coerced.length > 0) {
          markStoredMessagesAsProcessed(coerced as unknown[]);
          const sanitized = sanitizeMessages(coerced as unknown as ChatMessage[]);
          setMessages(sanitized.messages as unknown as typeof rawMessages);
          setHeldMessages(sanitized.held);
          // A turn whose UI action loaded this page may continue once (see below).
          loadedHistoryRef.current = activeSessionId;
        } else {
          setMessages([] as unknown as typeof rawMessages);
        }
        setLoadedSessionId(activeSessionId);
      } catch {
        if (cancelled) return;
        console.warn('[AiChatProvider] session.load failed');
        setSessionLoadFailure({ id: activeSessionId, error: new Error('Chat history could not be loaded. Reopen this chat to retry.') });
        setMessages([] as unknown as typeof rawMessages);
      } finally {
        if (!cancelled) setIsInitialized(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // rawMessages intentionally excluded — we only re-load on session switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, setMessages, markStoredMessagesAsProcessed, sessionRestoreAttempt, isBootstrapSentinel]);

  // A history loaded on a page a UI action opened with a full page load:
  // the turn continues once, within a minute, as a model call only. Nothing
  // of it runs again (its results are marked as processed above).
  useEffect(() => {
    if (loadedHistoryRef.current === null || loadedHistoryRef.current !== loadedSessionId) return;
    // The loaded messages reach the transport a render after the session id.
    if (loadedSessionId !== activeSessionId || rawMessages.length === 0) return;
    loadedHistoryRef.current = null;
    const continueTurn = transportRef.current.continueTurn;
    if (!reportsUiOutcomesRef.current || typeof continueTurn !== 'function') return;
    if (!continuesAfterPageLoad(rawMessages, Date.now())) return;
    const key = `glirastes.uiOutcomeContinued.${waitingToolCallIds(rawMessages).join(',')}`;
    if (CONTINUED_TURNS.has(key)) return;
    CONTINUED_TURNS.add(key);
    try {
      if (globalThis.sessionStorage?.getItem(key)) return;
      globalThis.sessionStorage?.setItem(key, '1');
    } catch {
      // Without storage the in-memory guard holds for this page.
    }
    const untrack = queueEnabledRef.current ? trackUiWork() : undefined;
    void Promise.resolve(continueTurn.call(transportRef.current)).catch(() => {
      console.warn('[glirastes] The turn could not be continued after the page load');
    }).finally(() => untrack?.());
  }, [rawMessages, loadedSessionId, activeSessionId, trackUiWork]);

  // A stored history the app handed to the transport itself (not through `session.load`): its outcomes
  // are read and the key is taken out of the transport's copies (the app's objects stay), so no later
  // request carries it. Only between requests: a running request already has its messages.
  useEffect(() => {
    if (isLoading || sessionNotReady) return;
    const stored = readStoredTurnOutcomes(rawMessages as unknown as ChatMessage[]);
    if (stored.messages === (rawMessages as unknown as ChatMessage[])) return;
    setMessages(stored.messages as unknown as typeof rawMessages);
    if (stored.outcomes.size === 0) return;
    setTurnOutcomes((prev) => {
      let next: Map<string, TurnOutcome> | null = null;
      for (const [userMessageId, outcome] of stored.outcomes) {
        if (prev.has(userMessageId)) continue;
        next ??= new Map(prev);
        next.set(userMessageId, outcome);
      }
      return next ?? prev;
    });
  }, [rawMessages, isLoading, sessionNotReady, setMessages]);

  // Save messages to session on change (scoped to the active session).
  useEffect(() => {
    if (!isInitialized) return;
    if (loadedSessionId !== activeSessionId) return;
    if (rawMessages.length === 0) return;
    const cfg = sessionRef.current;
    if (!cfg?.save) return;
    void Promise.resolve(
      saveOptionsRef.current
        ? cfg.save(activeSessionId, storedHistory(rawMessages as unknown as ChatMessage[], heldMessages, turnOutcomes), saveOptionsRef.current)
        : cfg.save(activeSessionId, storedHistory(rawMessages as unknown as ChatMessage[], heldMessages, turnOutcomes)),
    );
  }, [rawMessages, heldMessages, turnOutcomes, isInitialized, activeSessionId, loadedSessionId]);


  const runUiActions = useCallback((toolName: string, toolCallId: string, output: unknown) => {
    const actions = toolResultUiActions(output);
    if (actions.length === 0) return;
    const generation = uiActionGenerationRef.current;
    const { signal } = uiActionAbortRef.current;
    const record = output as Record<string, unknown>;
    // The model answers once this outcome is written: keep the composer locked until then.
    const awaited = reportsUiOutcomesRef.current && record.awaitsOutcome === true;
    if (awaited) setAwaitedOutcomes((count) => count + 1);
    const untrack = queueEnabledRef.current ? trackUiWork() : undefined;
    uiActionQueueRef.current = uiActionQueueRef.current.then(async () => {
      try {
        if (!mountedRef.current || pageLeavingRef.current || uiActionGenerationRef.current !== generation) return;
        currentUiRunRef.current = { toolName, toolCallId, output: record };
        const run = await runToolResultUiActions(
          output,
          uiActionBusRef.current ?? getDefaultUiActionBus(),
          {
            signal,
            ...(uiActionOutcomeTimeoutRef.current !== undefined ? { timeoutMs: uiActionOutcomeTimeoutRef.current } : {}),
          },
        ).catch((error: unknown) => ({ code: 'failed' as const, dispatched: 0, durationMs: 0, error }))
          .then(async (result) => {
            // The run timed out while its page load was being prepared: the bridge's push decides.
            const pageLoad = pageLoadRef.current;
            if (!result || (result.code !== 'timeout' && result.code !== 'unconfirmed') || pageLoad?.toolCallId !== toolCallId) {
              return result;
            }
            // Bounded: a push that never settles, or a reset, leaves the action unconfirmed.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const navigation = await Promise.race([
              pageLoad.done,
              new Promise<'unconfirmed'>((resolve) => {
                timer = setTimeout(() => resolve('unconfirmed'), BEFORE_PAGE_LOAD_TIMEOUT_MS);
                signal.addEventListener('abort', () => resolve('unconfirmed'), { once: true });
              }),
            ]).finally(() => clearTimeout(timer));
            const code = navigation === 'started' ? 'initiated' as const
              : navigation === 'refused' ? 'rejected-handler' as const
                : navigation === 'failed' ? 'failed' as const : 'unconfirmed' as const;
            return { ...result, code };
          })
          .finally(() => {
            currentUiRunRef.current = null;
            if (pageLoadRef.current?.toolCallId === toolCallId) pageLoadRef.current = null;
          });
        if (!run || uiActionGenerationRef.current !== generation) return;
        if (run.code === 'initiated') pageLeavingRef.current = true;
        if (run.code !== 'ok' && run.code !== 'initiated') {
          console.warn('[glirastes] A generated UI action was not carried out');
        }
        const reported = (await reportUiOutcome(toolName, toolCallId, record, run.code)) !== undefined;
        try {
          onUiActionOutcomeRef.current?.({
            toolName,
            toolCallId,
            code: run.code,
            actions: actions.map((action) => (typeof action.actionId === 'string'
              ? { type: action.type, actionId: action.actionId }
              : { type: action.type })),
            reported,
            durationMs: run.durationMs,
            ...(run.error !== undefined ? { error: run.error } : {}),
          });
        } catch {
          console.warn('[glirastes] onUiActionOutcome threw');
        }
      } finally {
        // One tick later: the transport has started the continuation by then.
        if (awaited) setTimeout(() => { if (mountedRef.current) setAwaitedOutcomes((count) => Math.max(0, count - 1)); }, 0);
        untrack?.();
      }
    });
  }, [reportUiOutcome, trackUiWork]);

  // Process tool results and approvals from streaming messages
  useEffect(() => {
    // A tool result runs only in the instance whose request delivered it:
    // while it streams, or in the render that ends it. A result first seen
    // otherwise (stored history, messages set by the host or a custom
    // transport, another tab) is never run later.
    if (staleRequestRef.current && !isLoading) staleRequestRef.current = false;
    const wasLive = liveRequestRef.current;
    liveRequestRef.current = isLoading && !staleRequestRef.current;
    // The messages a request starts from; its results come in the last one.
    if (liveRequestRef.current && !wasLive) requestBaseRef.current = rawMessages.map(({ id, role }) => ({ id, role }));
    // Another history replaced the messages (host, another tab): drop what
    // the left one queued, and the running request no longer delivers here.
    const replaced = !continuesRequestBase(rawMessages, requestBaseRef.current);
    if (replaced) {
      resetUiActions();
      requestBaseRef.current = rawMessages.map(({ id, role }) => ({ id, role }));
    }
    const live = !replaced && (liveRequestRef.current || wasLive);
    const lastMessage = rawMessages[rawMessages.length - 1];

    // Held-back results of a message that is no longer the last one run now, in their order.
    // A message that held results back and is no longer the last one: run its
    // results now, in call order, including those that arrived with the update
    // that moved on (a result of a call that never finished stays out).
    const heldMessageIds = [...new Set([...deferredResultsRef.current.values()].map((held) => held.messageId))]
      .filter((messageId) => lastMessage?.id !== messageId);
    for (const messageId of heldMessageIds) {
      // Gone from the messages, or the messages are no longer this request's: drop them.
      const message = live ? rawMessages.find((candidate) => candidate.id === messageId) : undefined;
      const results: Array<{ toolCallId: string; toolName: string; output: Record<string, unknown> }> = [];
      for (const part of message?.parts ?? []) {
        const toolPart = part as { type?: unknown; state?: unknown; output?: unknown; toolCallId?: unknown };
        if (typeof toolPart.type !== 'string' || !toolPart.type.startsWith('tool-')) continue;
        if (toolPart.state !== 'output-available' || !isRecord(toolPart.output)) continue;
        const toolCallId = typeof toolPart.toolCallId === 'string' && toolPart.toolCallId
          ? toolPart.toolCallId
          : `${messageId}-${toolPart.type}`;
        results.push({ toolCallId, toolName: toolPart.type.replace('tool-', ''), output: toolPart.output });
      }
      if (!message) {
        for (const [toolCallId, held] of deferredResultsRef.current) {
          if (held.messageId === messageId) processedToolCallsRef.current.add(toolCallId);
        }
      }
      for (const [toolCallId, held] of deferredResultsRef.current) {
        if (held.messageId === messageId) deferredResultsRef.current.delete(toolCallId);
      }
      for (const result of results) {
        if (processedToolCallsRef.current.has(result.toolCallId)) continue;
        processedToolCallsRef.current.add(result.toolCallId);
        if (carriesUiOutcome(result.output)) continue;
        onToolResultRef.current?.(result.toolName, result.output);
        runUiActions(result.toolName, result.toolCallId, result.output);
      }
    }

    if (!lastMessage || lastMessage.role !== 'assistant') return;

    // While the request streams, a result waits for every earlier call of the
    // message to finish, so UI actions run in call order, not arrival order.
    let earlierCallOpen = false;
    for (const part of lastMessage.parts) {
      if (!('type' in part)) continue;
      const partType = (part as { type: string }).type;

      if (partType.startsWith('tool-')) {
        const toolPart = part as {
          type: string;
          input?: unknown;
          output?: unknown;
          toolCallId?: string;
          state?: string;
          approval?: { id: string };
        };
        const toolName = partType.replace('tool-', '');

        // Detect approval-requested
        if (
          toolPart.state === 'approval-requested' &&
          toolPart.approval?.id &&
          !handledApprovalIdsRef.current.has(toolPart.approval.id)
        ) {
          handledApprovalIdsRef.current.add(toolPart.approval.id);
          const pending = describeApprovalCall({
            toolName,
            approvalId: toolPart.approval.id,
            input: toolPart.input,
            messages: rawMessages,
            declarations: declarationsRef.current,
            describe: approvalDescriptionRef.current,
            withSubjects: approvalSubjectsRef.current,
            ...(toolPart.toolCallId ? { toolCallId: toolPart.toolCallId } : {}),
            ...(languageRef.current ? { language: languageRef.current } : {}),
          });
          setPendingApprovalsMap(prev => new Map(prev).set(toolPart.approval!.id, pending));
        }

        if (
          toolPart.state === 'input-streaming'
          || toolPart.state === 'input-available'
          || toolPart.state === 'approval-requested'
          || toolPart.state === 'approval-responded'
        ) {
          earlierCallOpen = true;
          continue;
        }

        // Tool result available — call onToolResult
        if (toolPart.state === 'output-available' && isRecord(toolPart.output)) {
          const toolCallId = toolPart.toolCallId || `${lastMessage.id}-${partType}`;
          if (!processedToolCallsRef.current.has(toolCallId)) {
            // A result that already carries an outcome was run before.
            if (!live || carriesUiOutcome(toolPart.output)) {
              processedToolCallsRef.current.add(toolCallId);
              deferredResultsRef.current.delete(toolCallId);
              continue;
            }
            if (earlierCallOpen && isLoading) {
              deferredResultsRef.current.set(toolCallId, {
                toolName, output: toolPart.output, messageId: lastMessage.id,
              });
              continue;
            }
            deferredResultsRef.current.delete(toolCallId);
            processedToolCallsRef.current.add(toolCallId);
            onToolResultRef.current?.(toolName, toolPart.output);
            // Generated UI tools run in the browser through the app's bridge.
            runUiActions(toolName, toolCallId, toolPart.output);
          }
        }
      }
    }
  }, [rawMessages, isLoading, runUiActions, resetUiActions]);

  // Extract suggestions from suggest_followups tool, with a strict text
  // fallback for models that append a trailing Markdown suggestion section.
  useEffect(() => {
    if (rawMessages.length === 0) return;

    const count = suggestionsConfig.count ?? 3;
    let latestFollowups: string[] | null = null;

    for (let messageIndex = rawMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = rawMessages[messageIndex];
      if (message.role !== 'assistant') continue;

      let structuredFollowups: string[] | null = null;
      for (const part of message.parts) {
        if (!('type' in part)) continue;
        const partType = (part as { type: string }).type;

        if (partType !== 'tool-suggest_followups') continue;

        const toolPart = part as { output?: unknown; state?: string };
        if (toolPart.state !== 'output-available' || !isRecord(toolPart.output)) {
          continue;
        }

        const result = toolPart.output;
        if (!Array.isArray(result.followups)) continue;

        const followups = result.followups.filter(
          (f: unknown): f is string => typeof f === 'string' && f.trim().length > 0
        );

        if (followups.length > 0) {
          structuredFollowups = followups.slice(0, count);
        }
      }

      if (structuredFollowups && structuredFollowups.length > 0) {
        latestFollowups = structuredFollowups;
      } else {
        for (const part of message.parts) {
          if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
            continue;
          }
          const extracted = extractTrailingFollowupSuggestions(part.text, count);
          if (extracted.suggestions.length > 0) {
            latestFollowups = extracted.suggestions;
          }
        }
      }

      if (latestFollowups && latestFollowups.length > 0) {
        break;
      }
    }

    if (latestFollowups && latestFollowups.length > 0) {
      setSuggestionChips(latestFollowups);
    }
  }, [rawMessages, suggestionsConfig.count]);

  // Fallback to static chips when model doesn't call suggest_followups
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    // Trigger when loading transitions from true → false
    if (prevIsLoadingRef.current && !isLoading) {
      // If no dynamic chips were generated, restore static chips
      setSuggestionChips((current) => {
        if (current.length === 0 && suggestionsConfig.staticChips?.length) {
          return suggestionsConfig.staticChips;
        }
        return current;
      });
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading, suggestionsConfig.staticChips]);

  // Mention search
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!mentions || mentionQuery.trim().length === 0) {
        setMentionResults([]);
        setIsMentionSearching(false);
        return;
      }

      setIsMentionSearching(true);
      const query = mentionQuery.trim();
      const searchTypes = getMentionTypesForTrigger(mentions.types, mentionTrigger);

      const grouped = await Promise.all(
        searchTypes.map(async (type) => {
          try {
            return await mentions.search(query, type);
          } catch {
            return [];
          }
        }),
      );

      if (cancelled) return;

      const deduped = new Map<string, MentionResult>();
      for (const items of grouped) {
        for (const item of items) {
          deduped.set(`${item.type}:${item.id}`, item);
        }
      }

      setMentionResults(Array.from(deduped.values()));
      setIsMentionSearching(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [mentionQuery, mentionTrigger, mentions]);

  // Actions
  // The shared tail of every send: transport hygiene, then the transport.
  // `keepComposer`: the composer state was handled already (queued and direct sends with the queue on),
  // so a request that ends later does not wipe what the user is composing meanwhile.
  const deliver = useCallback(async (
    processedMessage: string,
    files?: FilePart[],
    deliverOptions?: { keepComposer?: boolean },
  ): Promise<boolean> => {
    // An open approval is decided on its card. A typed "yes" must not count as
    // approval, and rejecting it on send dropped requests the user wanted.
    if (pendingApprovalsMap.size > 0) {
      setApprovalReminder(true);
      return false;
    }

    // Clear truncation and suggestion chips on new message
    setTruncation(null);
    setSuggestionChips([]);
    setPipelineSteps([]);
    setPipelineState(null);

    // Sanitize messages before sending to prevent AI_MissingToolResultsError
    const currentMessages = rawMessages;
    const { messages: sanitized, held } = sanitizeMessages(currentMessages as unknown as ChatMessage[]);
    if (
      sanitized.length !== currentMessages.length
      || sanitized.some((message, index) => message !== (currentMessages[index] as unknown))
    ) {
      // What is left out is not sent; a message that still shows a step stays on screen and in the store.
      if (held.length > 0) setHeldMessages((prev) => [...prev, ...held]);
      setMessages(sanitized as unknown as typeof rawMessages);
      setPendingApprovalsMap(new Map());
    }

    await sendMessage(files && files.length > 0 ? { text: processedMessage, files } : { text: processedMessage });
    if (deliverOptions?.keepComposer) return true;
    setActiveMentions([]);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
    return true;
  }, [
    rawMessages,
    setMessages,
    sendMessage,
    pendingApprovalsMap,
  ]);

  // Everything a send does before the transport, synchronously: commands, mentions,
  // `onBeforeSend` and the clarification answer. Queued messages run through it when sent.
  const prepareSend = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): PreparedSend => {
    const mentionsForSend = sendOptions?.mentions ?? activeMentions;
    const files = sendOptions?.files;

    // A `/` command alone runs without the model; missing arguments open its form.
    const plan = interactionRegistry?.planMessage(message, mentionsForSend);
    if (plan?.status === 'needs-args') {
      return { kind: 'needs-args', request: plan.request };
    }
    if (plan?.status === 'send') {
      return { kind: 'command', text: plan.text };
    }

    // Preprocess message
    let processedMessage = plan?.status === 'prompt' ? plan.text : message;
    const mentionSerializeConfig = mentions?.serialize;
    if (mentionSerializeConfig?.enabled !== false) {
      processedMessage = serializeMentionsForSend(
        processedMessage,
        mentionsForSend,
        mentionSerializeConfig,
      );
    }
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, mentionsForSend);
    }

    // Typing into the composer while a clarification is open answers it, so
    // the server resumes the original request instead of starting over.
    const openClarification = findOpenClarification(
      rawMessages as unknown as Array<{ role: string; parts: unknown[] }>,
    );
    if (
      openClarification?.request.allowFreeText
      && processedMessage.trim().length > 0
      && processedMessage.length <= CLARIFICATION_MAX_ANSWER_LENGTH
      && !parseClarificationAnswer(processedMessage)
    ) {
      processedMessage = clarificationAnswerMessage({
        toolCallId: openClarification.toolCallId,
        answer: processedMessage,
      });
    }

    return { kind: 'message', text: processedMessage, ...(files ? { files } : {}) };
  }, [
    rawMessages,
    interactionRegistry,
    mentions,
    onBeforeSend,
    activeMentions,
  ]);

  const dispatchSend = useCallback(async (
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
    deliverOptions?: { keepComposer?: boolean },
  ): Promise<void> => {
    const prepared = prepareSend(message, sendOptions);
    if (prepared.kind === 'needs-args') {
      setPendingCommand(prepared.request);
      return;
    }
    if (prepared.kind === 'command') {
      setPendingCommand(null);
      await deliver(prepared.text, undefined, deliverOptions);
      return;
    }
    await deliver(prepared.text, prepared.files, deliverOptions);
  }, [prepareSend, deliver]);

  // Decides synchronously whether the message is taken, so any composer can
  // keep the typed text when it is not.
  // Null when taken, else why not.
  const sendDirect = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): ChatSubmitRejectionReason | null => {
    if (sessionNotReady || sessionMutationRef.current) return 'session';
    if (pendingApprovalsMap.size > 0) {
      setApprovalReminder(true);
      return 'approval-open';
    }
    if (sendOptions?.files?.length) {
      if (!attachmentOptions) return 'attachments-off';
      // A direct command runs without the model, which would silently drop the files.
      const plan = interactionRegistry?.planMessage(message, sendOptions.mentions ?? activeMentions);
      if (plan?.status === 'send' || plan?.status === 'needs-args') return 'files-with-command';
    }
    void dispatchSend(message, sendOptions);
    return null;
  }, [sessionNotReady, pendingApprovalsMap, dispatchSend, attachmentOptions, interactionRegistry, activeMentions]);

  // ---------------------------------------------------------------------------
  // Message queue (`queue.enabled`): what keeps a message from being sent now.
  // ---------------------------------------------------------------------------
  // The approval map is filled a render after the stream ends; the parts say it already.
  const approvalWaiting = pendingApprovalsMap.size > 0
    || (queueEnabled && lastStepAwaitsApproval(rawMessages));
  // An answered approval (approved or rejected) the transport may send on by itself.
  const [decisionResend, setDecisionResend] = useState(false);
  useEffect(() => {
    if (isLoading && decisionResend) setDecisionResend(false);
  }, [isLoading, decisionResend]);
  useEffect(() => {
    // A transport that does not continue by itself (`autoResumeOnApproval: false`) never
    // starts that request: the queue goes on shortly after the answer instead of waiting forever.
    if (!decisionResend || isLoading || processingApprovalIds.size > 0) return undefined;
    const timer = setTimeout(() => setDecisionResend(false), APPROVAL_RESEND_GRACE_MS);
    return () => clearTimeout(timer);
  }, [decisionResend, isLoading, processingApprovalIds]);
  const resendPending = processingApprovalIds.size > 0
    || (queueEnabled && decisionResend && shouldContinueChat({ messages: rawMessages }));
  const transportBusy = isLoading || awaitedOutcomes > 0 || pendingUiWork > 0;
  /** A message sent now waits in the queue. */
  const queueBusy = transportBusy || approvalWaiting || resendPending;
  const clarificationOpen = queueEnabled
    && findOpenClarification(rawMessages as unknown as Array<{ role: string; parts: unknown[] }>) !== undefined;
  /** Also holds a queued message: it never answers a clarification or a command form by itself. */
  const flushHeld = queueBusy || clarificationOpen || pendingCommand !== null || sessionNotReady || isSessionMutating
    || queueStore.restoring;
  const [flushTick, setFlushTick] = useState(0);

  const submitOutcome = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): ChatSubmitOutcome => {
    if (!queueEnabled) {
      const refused = sendDirect(message, sendOptions);
      return refused ? { status: 'rejected', reason: refused } : { status: 'sent' };
    }
    if (sessionNotReady || sessionMutationRef.current) return { status: 'rejected', reason: 'session' };
    const mentionsForSend = sendOptions?.mentions ?? activeMentions;
    const files = sendOptions?.files;
    if (files?.length) {
      if (!attachmentOptions) return { status: 'rejected', reason: 'attachments-off' };
      // A direct command runs without the model, which would silently drop the files.
      const plan = interactionRegistry?.planMessage(message, mentionsForSend);
      if (plan?.status === 'send' || plan?.status === 'needs-args') {
        return { status: 'rejected', reason: 'files-with-command' };
      }
    }
    const queued = queueStore.itemsRef.current;
    const resetComposer = () => {
      setActiveMentions([]);
      setMentionQuery('');
      setMentionTrigger(null);
      setMentionResults([]);
      setIsMentionSearching(false);
    };
    // An open clarification is answered by what the user sends now, ahead of the queue (which waits for it).
    // While the stored queue is read, a new message queues behind what it brings.
    const busy = queueBusy || sendInFlightRef.current || pendingUiWorkRef.current > 0
      || queueStore.restoringRef.current || pendingCommand !== null || (queued.length > 0 && !clarificationOpen);
    if (!busy) {
      // Idle: sent at once, so an open clarification is answered as before.
      resetComposer();
      sendInFlightRef.current = true;
      void dispatchSend(message, { mentions: [...mentionsForSend], ...(files ? { files } : {}) }, { keepComposer: true })
        .finally(() => {
          sendInFlightRef.current = false;
          if (mountedRef.current) setFlushTick((tick) => tick + 1);
        });
      return { status: 'sent' };
    }
    if (queued.length >= queueConfig.maxSize) return { status: 'rejected', reason: 'queue-full' };
    // The hint shows for the message that starts waiting for the card, not for every one after it.
    if (approvalWaiting && queued.length === 0) setApprovalReminder(true);
    queueStore.commit(
      [...queued, createQueuedMessage(message, { mentions: mentionsForSend, ...(files ? { files } : {}) })],
      queueStore.pausedRef.current,
      'added',
    );
    resetComposer();
    return { status: 'queued' };
  }, [
    queueEnabled, sendDirect, sessionNotReady, activeMentions, attachmentOptions, interactionRegistry,
    queueStore, queueBusy, dispatchSend, queueConfig.maxSize, approvalWaiting, clarificationOpen, pendingCommand,
  ]);

  // The latest refused message, for an app to explain it (also one the built-in composers sent).
  const [lastRejection, setLastRejection] = useState<ChatSubmitRejection | null>(null);
  const submitWithResult = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): ChatSubmitOutcome => {
    const outcome = submitOutcome(message, sendOptions);
    // Null stays null without a render.
    setLastRejection(outcome.status === 'rejected' ? { reason: outcome.reason, at: Date.now() } : null);
    return outcome;
  }, [submitOutcome]);
  const submit = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): ChatSubmitResult => submitWithResult(message, sendOptions).status, [submitWithResult]);
  const send = useCallback((
    message: string,
    sendOptions?: { mentions?: MentionData[]; files?: FilePart[] },
  ): boolean => submitWithResult(message, sendOptions).status !== 'rejected', [submitWithResult]);

  const submitPendingCommand = useCallback((
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ): boolean => {
    if (!pendingCommand || !interactionRegistry || sessionNotReady || sessionMutationRef.current) return false;
    // With the queue the composer stays usable during a run; a command still waits for it.
    if (queueEnabled && (queueBusy || sendInFlightRef.current)) return false;
    const plan = interactionRegistry.completeCommand(pendingCommand, values, valueLabels);
    if (plan.status !== 'send') {
      setPendingCommand(plan.status === 'needs-args' ? plan.request : null);
      return plan.status !== 'needs-args';
    }
    setPendingCommand(null);
    void deliver(plan.text, undefined, queueEnabled ? { keepComposer: true } : undefined);
    return true;
  }, [pendingCommand, interactionRegistry, sessionNotReady, deliver, queueEnabled, queueBusy]);

  const cancelPendingCommand = useCallback(() => setPendingCommand(null), []);

  const runEntityAction = useCallback((
    entity: { type: string; id: string; label: string },
    actionId: string,
  ) => {
    if (sessionNotReady || sessionMutationRef.current) return;
    if (queueEnabled && (queueBusy || sendInFlightRef.current)) return;
    const plan = interactionRegistry?.planAction(entity, actionId);
    if (!plan) return;
    if (plan.status === 'needs-args') {
      setPendingCommand(plan.request);
      return;
    }
    setPendingCommand(null);
    void deliver(plan.text, undefined, queueEnabled ? { keepComposer: true } : undefined);
  }, [interactionRegistry, sessionNotReady, deliver, queueEnabled, queueBusy]);

  const mentionEntity = useCallback(async (type: string, id: string): Promise<boolean> => {
    const entity = interactionRegistry?.entity(type);
    if (!entity?.resolve) return false;
    let item;
    try {
      item = toChatEntityItem(await entity.resolve(id));
    } catch {
      return false;
    }
    if (!item) return false;
    const resolved = item;
    setComposerMentions((previous) => [...previous, {
      id: resolved.id,
      type,
      label: resolved.label,
      displayName: resolved.label,
      prefix: entityPrefix,
      slug: normalizeMentionSlug(resolved.label),
    }]);
    return true;
  }, [interactionRegistry, entityPrefix]);

  const consumeComposerMentions = useCallback(() => setComposerMentions([]), []);

  const stop = useCallback(() => {
    // The running turn keeps that it was stopped, also when nothing of its answer arrived yet.
    if (streamActiveRef.current) recordTurnOutcome('aborted', selfAbortRef.current ? 'send-now' : 'stopped');
    // The user stopped the run: what is queued waits (unless `sendNow` stopped it to go next).
    if (
      queueEnabledRef.current && !selfAbortRef.current && queueConfig.pauseOn.has('aborted')
      && queueStore.itemsRef.current.length > 0 && !queueStore.pausedRef.current
    ) {
      queueStore.commit(queueStore.itemsRef.current, true, 'paused');
    }
    setPipelineState((prev) => ({
      status: 'aborted',
      totalSteps: prev?.totalSteps ?? pipelineSteps.length,
      finishReason: 'stop',
      maxSteps: prev?.maxSteps ?? 1,
      stepLimitSource: prev?.stepLimitSource ?? 'safety',
      updatedAt: new Date().toISOString(),
      message: 'Stopped by user.',
    }));
    transportStop();
  }, [transportStop, pipelineSteps.length, queueConfig.pauseOn, queueStore, recordTurnOutcome]);

  const clear = useCallback(() => {
    resetUiActions();
    // A request still running belonged to the cleared history: its outcome is recorded nowhere.
    if (streamActiveRef.current) requestTurnRef.current = { sessionId: null, userMessageId: null };
    setLastRejection(null);
    setMessages([]);
    void Promise.resolve(sessionRef.current?.clear?.(activeSessionId));
    processedToolCallsRef.current.clear();
    handledApprovalIdsRef.current.clear();
    setPendingApprovalsMap(new Map());
    setVisibleMessageCount(30);
    setTruncation(null);
    setPipelineSteps([]);
    setPipelineState(null);
    setTurnOutcomes(new Map());
    turnEndPendingRef.current.clear();
    setHeldMessages([]);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setActiveMentions([]);
    setIsMentionSearching(false);
    setPendingCommand(null);
    setSuggestionChips(suggestionsConfig.staticChips ?? []);
    // The queue belonged to the cleared conversation.
    queueStore.clearAll();
  }, [setMessages, activeSessionId, suggestionsConfig.staticChips, resetUiActions, queueStore]);

  // ---------------------------------------------------------------------------
  // Multi-session actions
  // ---------------------------------------------------------------------------

  const applyActiveId = useCallback(
    (id: string) => {
      if (session?.activeId === undefined) {
        // Uncontrolled
        setUncontrolledActiveId(id);
      }
      session?.onActiveIdChange?.(id);
    },
    [session],
  );

  const refreshSessions = useCallback(async () => {
    const cfg = sessionRef.current;
    if (!cfg?.list) return;
    setIsSessionsLoading(true);
    try {
      const list = await cfg.list();
      setSessions(list);
      // Auto-select the first session if we're still on the bootstrap
      // sentinel and the consumer doesn't control `activeId` externally.
      if (
        !streamActiveRef.current &&
        list.length > 0 &&
        cfg.activeId === undefined &&
        !list.some((s) => s.id === uncontrolledActiveIdRef.current)
      ) {
        const next = list[0].id;
        setUncontrolledActiveId(next);
        cfg.onActiveIdChange?.(next);
      }
    } catch {
      console.warn('[AiChatProvider] session.list failed');
    } finally {
      setIsSessionsLoading(false);
    }
  }, []);

  // Mirror state into a ref so refreshSessions doesn't need it as a dep.
  const uncontrolledActiveIdRef = useRef(uncontrolledActiveId);
  uncontrolledActiveIdRef.current = uncontrolledActiveId;

  // Auto-fetch sessions when the consumer supplies a list() function.
  useEffect(() => {
    if (!sessionsSupported) return;
    void refreshSessions();
  }, [sessionsSupported, refreshSessions]);

  // Refetch sessions when a streaming response finishes, so backend-generated
  // titles (auto-generated after the first exchange) appear without a reload.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (!sessionsSupported) {
      wasLoadingRef.current = isLoading;
      return;
    }
    if (wasLoadingRef.current && !isLoading) {
      void refreshSessions();
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, sessionsSupported, refreshSessions]);

  const switchSession = useCallback(
    async (id: string) => {
      if (streamActiveRef.current) return;
      if (id === activeSessionId) {
        if (sessionLoadFailure?.id === id) setSessionRestoreAttempt((attempt) => attempt + 1);
        return;
      }
      // Reset transient UI state before loading new session
      setPendingApprovalsMap(new Map());
      setTruncation(null);
      setPipelineSteps([]);
      setPipelineState(null);
      setSuggestionChips(suggestionsConfig.staticChips ?? []);
      setVisibleMessageCount(30);
      applyActiveId(id);
    },
    [activeSessionId, applyActiveId, suggestionsConfig.staticChips, isLoading, sessionLoadFailure],
  );

  const createSession = useCallback(
    async (opts?: { title?: string }): Promise<SessionSummary | null> => {
      if (streamActiveRef.current || sessionMutationRef.current) return null;
      const cfg = sessionRef.current;
      if (!cfg?.create) return null;
      sessionMutationRef.current = true;
      setIsSessionMutating(true);
      try {
        const created = await cfg.create(opts);
        await refreshSessions();
        await switchSession(created.id);
        return created;
      } finally {
        sessionMutationRef.current = false;
        setIsSessionMutating(false);
      }
    },
    [refreshSessions, switchSession, isLoading],
  );

  const removeSession = useCallback(
    async (id: string) => {
      if (streamActiveRef.current || sessionMutationRef.current) return;
      const cfg = sessionRef.current;
      if (!cfg?.remove) return;
      sessionMutationRef.current = true;
      setIsSessionMutating(true);
      try {
        await cfg.remove(id);
        // Re-fetch first so the fallback target reflects reality
        const cfgList = cfg.list ? await cfg.list() : [];
        setSessions(cfgList);
        if (id === activeSessionId) {
          const next = cfgList.find((s) => s.id !== id);
          if (next) {
            await switchSession(next.id);
          } else if (cfg.create) {
            // No sessions left — spin up a fresh one
            const created = await cfg.create();
            const refreshed = cfg.list ? await cfg.list() : [created];
            setSessions(refreshed);
            await switchSession(created.id);
          }
        }
      } finally {
        sessionMutationRef.current = false;
        setIsSessionMutating(false);
      }
    },
    [activeSessionId, switchSession, isLoading],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const cfg = sessionRef.current;
      if (!cfg?.rename) return;
      await cfg.rename(id, title);
      await refreshSessions();
    },
    [refreshSessions],
  );

  // Pagination + consolidation (removes duplicate assistant bubbles from pipeline resumes)
  const allMessages = withHeldMessages(rawMessages as unknown as ChatMessage[], heldMessages);
  const consolidated = consolidateAssistantMessages(allMessages);
  const hasMore = consolidated.length > visibleMessageCount;
  const visibleMessages = hasMore
    ? consolidated.slice(-visibleMessageCount)
    : consolidated;

  const loadMore = useCallback(() => {
    setVisibleMessageCount(prev => prev + 10);
  }, []);

  // A run ended by itself: its turn completed, unless it stopped or failed meanwhile, or an approval holds it.
  const outcomeRunEndRef = useRef(isLoading);
  useEffect(() => {
    const ended = outcomeRunEndRef.current && !isLoading;
    outcomeRunEndRef.current = isLoading;
    if (!ended) return;
    if (status === 'error' || transportError) {
      recordTurnOutcome('error', 'request-failed');
      return;
    }
    // A run of a chat that is not open: whether it ended at an approval is not known here, so no `completed`.
    if (!requestTurn()?.open) return;
    // The turn goes on once the approval is decided.
    const current = rawMessagesRef.current;
    const turnStart = current.map((message) => message.role).lastIndexOf('user');
    const waiting = current.slice(turnStart + 1).some((message) => message.role === 'assistant'
      && (message.parts as unknown[]).some((part) => isRecord(part) && part.state === 'approval-requested'));
    if (!waiting) recordTurnOutcome('completed', 'finished', true);
  }, [isLoading, status, transportError, recordTurnOutcome, requestTurn]);

  // A request started: its outcome is bound to this chat and its latest user message now. A request
  // started for a turn that already ended (a retry): its outcome follows the new attempt.
  const outcomeRunLoadingRef = useRef(isLoading);
  useEffect(() => {
    const started = isLoading && !outcomeRunLoadingRef.current;
    outcomeRunLoadingRef.current = isLoading;
    if (!started) return;
    const userMessageId = latestUserMessageId(rawMessagesRef.current as unknown as ChatMessage[]);
    requestTurnRef.current = { sessionId: loadedSessionIdRef.current, userMessageId };
    if (!userMessageId) return;
    setTurnOutcomes((prev) => {
      if (!prev.has(userMessageId)) return prev;
      const next = new Map(prev);
      next.delete(userMessageId);
      return next;
    });
  }, [isLoading]);

  // `onTurnEnd`: after every commit (declared after the run start and end above, so it sees what they bound),
  // report each live-recorded outcome whose state update is applied, once its turn is over: its request is
  // no longer the running one (a queued `sendNow` started the next), or nothing runs and no UI action outcome
  // is awaited (a continuation of the same turn would follow). Held while the turn asks for an approval (the
  // decided run goes on with it) and once a UI action started a page load (the next page continues and
  // reports the turn). Only for the chat that is open.
  useEffect(() => {
    const pending = turnEndPendingRef.current;
    if (pending.size === 0) return;
    // Without a callback nothing is reported later either (and no extra render happens).
    if (!onTurnEndRef.current) {
      pending.clear();
      return;
    }
    const busy = isLoading || awaitedOutcomes > 0;
    const runningFor = requestTurnRef.current?.userMessageId ?? null;
    const sessionId = loadedSessionIdRef.current;
    let applyPending = false;
    for (const [userMessageId, recorded] of [...pending]) {
      if (turnEndQueuedRef.current.has(userMessageId)) {
        applyPending = true;
        continue;
      }
      if (recorded.sessionId !== sessionId || sessionId !== activeSessionIdRef.current) {
        pending.delete(userMessageId);
        continue;
      }
      const outcome = turnOutcomes.get(userMessageId);
      // Not committed yet, or taken out by a new request for the same turn (that request reports).
      if (!outcome || outcome.status !== recorded.status || outcome.reason !== recorded.reason) continue;
      if (busy && runningFor === userMessageId) continue;
      if (pageLeavingRef.current) continue;
      if (turnAwaitsApproval(rawMessagesRef.current, userMessageId)) continue;
      pending.delete(userMessageId);
      try {
        // An async callback's rejection is caught as a throw is.
        const returned: unknown = onTurnEndRef.current?.(outcome, { sessionId });
        if ((typeof returned === 'object' || typeof returned === 'function') && returned !== null
          && typeof (returned as { then?: unknown }).then === 'function') {
          (returned as PromiseLike<unknown>).then(undefined, () => { console.warn('[glirastes] onTurnEnd threw'); });
        }
      } catch {
        console.warn('[glirastes] onTurnEnd threw');
      }
    }
    // A record still to be applied may leave the state as it is, and React then runs no effect: look again
    // after it was applied.
    if (applyPending) setTurnEndCheck((count) => count + 1);
  });

  // A request started: every answer before it was sent.
  useEffect(() => {
    if (isLoading) setResendApprovalIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [isLoading]);
  const isApprovalResendPending = useCallback((approvalId: string) => (
    resendApprovalIds.has(approvalId) && shouldContinueChat({ messages: rawMessages })
  ), [resendApprovalIds, rawMessages]);

  // Approval handlers
  const approve = useCallback(async (id: string) => {
    setApprovalError(null);
    setProcessingApprovalIds((prev) => new Set(prev).add(id));
    setResendApprovalIds((prev) => new Set(prev).add(id));
    if (queueEnabledRef.current) setDecisionResend(true);
    try {
      await addToolApprovalResponse({ id, approved: true });
      setPendingApprovalsMap((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch {
      setApprovalError(new Error('Tool approval response failed.'));
    } finally {
      setProcessingApprovalIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [addToolApprovalResponse]);

  const reject = useCallback(async (id: string) => {
    setApprovalError(null);
    setProcessingApprovalIds((prev) => new Set(prev).add(id));
    if (queueEnabledRef.current) setDecisionResend(true);
    try {
      await addToolApprovalResponse({
        id,
        approved: false,
        reason: 'Rejected by user.',
      });
      setPendingApprovalsMap((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch {
      setApprovalError(new Error('Tool approval response failed.'));
    } finally {
      setProcessingApprovalIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [addToolApprovalResponse]);

  // ---------------------------------------------------------------------------
  // Message queue: pause on a run's end, send the next message once idle.
  // ---------------------------------------------------------------------------
  const queueRunLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = queueRunLoadingRef.current;
    queueRunLoadingRef.current = isLoading;
    if (!queueEnabled || !wasLoading || isLoading) return;
    // A run ended: an error, a stop, a safety stop or a continue prompt holds what is queued.
    const selfAbort = selfAbortRef.current;
    selfAbortRef.current = false;
    const trigger: ChatQueuePauseTrigger | null = status === 'error' || transportError
      ? 'error'
      : pipelineState?.status === 'aborted' && !selfAbort
        ? 'aborted'
        : pipelineState?.status === 'safety-stop'
          ? 'safety-stop'
          : truncation ? 'truncation' : null;
    if (
      trigger && queueConfig.pauseOn.has(trigger)
      && queueStore.itemsRef.current.length > 0 && !queueStore.pausedRef.current
    ) {
      queueStore.commit(queueStore.itemsRef.current, true, 'paused');
    }
  }, [isLoading, queueEnabled, status, transportError, pipelineState, truncation, queueConfig.pauseOn, queueStore]);

  useEffect(() => {
    if (!queueEnabled || flushHeld || sendInFlightRef.current || pendingUiWorkRef.current > 0) return;
    const queued = queueStore.itemsRef.current;
    if (queued.length === 0) return;
    const priorityId = queueStore.priorityRef.current;
    const head = (priorityId ? queued.find((item) => item.id === priorityId) : undefined) ?? queued[0]!;
    const priority = head.id === priorityId;
    // Open in an editor: neither it nor anything behind it goes out.
    if (head.id === queueStore.editingRef.current) return;
    if (!priority && (queueStore.pausedRef.current || !queueConfig.autoFlush)) return;
    const files = head.files && head.files.length > 0 ? [...head.files] : undefined;
    let prepared: PreparedSend;
    try {
      // Processed now, like a typed message: commands, mentions, `onBeforeSend`.
      prepared = prepareSend(head.text, { mentions: [...(head.mentions ?? [])], ...(files ? { files } : {}) });
    } catch {
      console.warn('[glirastes] A queued message could not be prepared');
      // Held until the user acts again: also a `sendNow` message does not retry by itself.
      queueStore.priorityRef.current = null;
      queueStore.commit(queued, true, 'paused');
      return;
    }
    if (files && (prepared.kind !== 'message' || !attachmentOptions)) {
      // Attachments were turned off since it was queued, or it became a direct command: never sent with the files.
      // Edited into a direct command after it was queued with files: a command would drop them.
      queueStore.priorityRef.current = null;
      queueStore.commit(queued, true, 'paused');
      return;
    }
    queueStore.priorityRef.current = null;
    queueStore.commit(queued.filter((item) => item !== head), queueStore.pausedRef.current, 'sent');
    if (prepared.kind === 'needs-args') {
      // Its command form opens; the queue waits for it.
      setPendingCommand(prepared.request);
      return;
    }
    if (prepared.kind === 'command') setPendingCommand(null);
    sendInFlightRef.current = true;
    void deliver(
      prepared.text,
      prepared.kind === 'message' ? prepared.files : undefined,
      { keepComposer: true },
    ).then((delivered) => {
      // Not taken after all (an approval opened): it goes first again.
      if (!delivered && mountedRef.current) {
        queueStore.commit([head, ...queueStore.itemsRef.current], queueStore.pausedRef.current, 'added');
      }
    }).catch(() => {
      console.warn('[glirastes] A queued message could not be sent');
    }).finally(() => {
      sendInFlightRef.current = false;
      if (mountedRef.current) setFlushTick((tick) => tick + 1);
    });
  }, [
    queueEnabled, flushHeld, pendingUiWork, flushTick, queueStore, queueConfig.autoFlush, prepareSend, deliver, attachmentOptions,
  ]);

  const sendNow = useCallback((id: string): boolean => {
    if (!queueEnabled) return false;
    const queued = queueStore.itemsRef.current;
    const item = queued.find((entry) => entry.id === id);
    // Open in an editor: save or cancel the edit first.
    if (!item || queueStore.editingRef.current === id) return false;
    if (approvalWaiting) {
      // A typed message never decides an approval, unless the app chose so.
      if (queueConfig.sendNowDuringApproval === 'refuse') {
        setApprovalReminder(true);
        return false;
      }
      for (const approval of pendingApprovalsMap.values()) void reject(approval.id);
    }
    queueStore.priorityRef.current = id;
    queueStore.commit([item, ...queued.filter((entry) => entry !== item)], queueStore.pausedRef.current, 'reordered');
    if (queueConfig.sendNowBehavior === 'abort' && isLoading) {
      selfAbortRef.current = true;
      stop();
    }
    return true;
  }, [queueEnabled, queueStore, approvalWaiting, queueConfig, pendingApprovalsMap, reject, isLoading, stop]);

  const removeQueued = useCallback((id: string): boolean => {
    const queued = queueStore.itemsRef.current;
    if (!queued.some((item) => item.id === id)) return false;
    queueStore.commit(queued.filter((item) => item.id !== id), queueStore.pausedRef.current, 'removed');
    return true;
  }, [queueStore]);

  const editQueued = useCallback((id: string, text: string): boolean => {
    const queued = queueStore.itemsRef.current;
    const item = queued.find((entry) => entry.id === id);
    if (text.trim() === '' || !item) return false;
    if (item.files?.length) {
      // As on send: a direct command cannot carry the files queued with it.
      const plan = interactionRegistry?.planMessage(text, [...(item.mentions ?? [])]);
      if (plan?.status === 'send' || plan?.status === 'needs-args') return false;
    }
    if (queueStore.editingRef.current === id) queueStore.setEditing(null);
    queueStore.commit(
      queued.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
      queueStore.pausedRef.current,
      'edited',
    );
    return true;
  }, [queueStore, interactionRegistry]);

  const beginEdit = useCallback((id: string): boolean => {
    if (!queueStore.itemsRef.current.some((item) => item.id === id)) return false;
    queueStore.setEditing(id);
    return true;
  }, [queueStore]);

  const cancelEdit = useCallback(() => {
    if (queueStore.editingRef.current !== null) queueStore.setEditing(null);
  }, [queueStore]);

  const clearQueue = useCallback(() => {
    queueStore.clearAll();
  }, [queueStore]);

  const resumeQueue = useCallback(() => {
    if (!queueStore.pausedRef.current) return;
    queueStore.commit(queueStore.itemsRef.current, false, 'resumed');
  }, [queueStore]);

  const pauseQueue = useCallback(() => {
    if (!queueEnabled || queueStore.pausedRef.current) return;
    queueStore.commit(queueStore.itemsRef.current, true, 'paused');
  }, [queueEnabled, queueStore]);

  const queueState = useMemo<ChatQueueState>(
    () => ({
      enabled: queueEnabled,
      items: queueStore.items,
      paused: queueStore.paused,
      restoring: queueStore.restoring,
      editingId: queueStore.editingId,
    }),
    [queueEnabled, queueStore.items, queueStore.paused, queueStore.restoring, queueStore.editingId],
  );

  // Truncation
  const continueTruncation = useCallback(async () => {
    setTruncation(null);
    await sendMessage({ text: continueMessage });
  }, [sendMessage, continueMessage]);

  const dismissTruncation = useCallback(() => {
    setTruncation(null);
  }, []);

  // Pending approvals as array (for context consumers)
  const pendingApprovals = useMemo(
    () => Array.from(pendingApprovalsMap.values()),
    [pendingApprovalsMap],
  );

  // Mention actions
  const setMentionSearch = useCallback((query: string, trigger: MentionTrigger) => {
    setMentionQuery(query);
    setMentionTrigger(trigger);
  }, []);

  const clearMentionSearch = useCallback(() => {
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
  }, []);

  const addActiveMention = useCallback((mention: MentionData) => {
    const mentionId = typeof mention.id === 'string' ? mention.id : '';
    const mentionType = typeof mention.type === 'string' ? mention.type : '';
    if (!mentionId || !mentionType) return;

    setActiveMentions((prev) => {
      const mentionKey = `${mentionType}:${mentionId}`;
      const next = prev.filter((item) => `${item.type}:${item.id}` !== mentionKey);
      next.push(mention);
      return next;
    });
  }, []);

  const removeActiveMention = useCallback((mentionId: string) => {
    setActiveMentions((prev) => prev.filter((item) => item.id !== mentionId));
  }, []);

  const clearActiveMentions = useCallback(() => {
    setActiveMentions([]);
  }, []);

  const selectMention = useCallback((result: MentionResult) => {
    if (mentions?.resolve) {
      void mentions.resolve(result.id, result.type)
        .then((resolved) => {
          addActiveMention({
            ...resolved,
            id: result.id,
            type: result.type,
            label: typeof resolved.label === 'string' ? resolved.label : result.label,
            displayName: typeof resolved.displayName === 'string'
              ? resolved.displayName
              : result.label,
          });
        })
        .catch(() => {
          addActiveMention({
            id: result.id,
            type: result.type,
            label: result.label,
            displayName: result.label,
          });
        });
    } else {
      addActiveMention({
        id: result.id,
        type: result.type,
        label: result.label,
        displayName: result.label,
      });
    }

    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
  }, [mentions, addActiveMention]);

  const selectSuggestion = useCallback((suggestion: string) => {
    send(suggestion);
  }, [send]);

  const refreshSuggestions = useCallback(() => {
    // Suggestions are driven by tool output, not manual refresh
  }, []);

  // Build context value
  const contextValue = useMemo<ChatContextValue & ComposerContextValue>(
    () => ({
      classNames,
      components,
      locale,
      themeVars,
      themeEffect,
      unstyled,
      suggestions: suggestionsConfig,
      toolLabels,
      toolResults: toolResultConfig,
      activityLog: activityLogConfig,
      toolRendererRegistry,
      attachments: attachmentOptions,
      voice: voiceConfig,
      mentionConfig: mentions,
      pipelineMessageTranslator,
      stepSummaryFormatter,
      messages: visibleMessages,
      // A UI action whose outcome the model waits for holds the turn open.
      isLoading: isLoading || awaitedOutcomes > 0 || isSessionMutating || sessionNotReady,
      isSessionChangeBlocked: isLoading || awaitedOutcomes > 0 || isSessionMutating,
      error: error ?? approvalError,
      send,
      submit,
      submitWithResult,
      lastRejection,
      canCompose: queueEnabled
        ? !(isSessionMutating || sessionNotReady)
        : !(isLoading || awaitedOutcomes > 0 || isSessionMutating || sessionNotReady),
      queue: queueState,
      sendNow,
      removeQueued,
      editQueued,
      beginEdit,
      cancelEdit,
      clearQueue,
      resumeQueue,
      pauseQueue,
      stop,
      clear,
      loadMore,
      hasMore,
      pipelineSteps,
      pipelineState,
      turnOutcomes,
      pendingApprovals,
      approvalReminder,
      approve,
      reject,
      isProcessingApproval: processingApprovalIds.size > 0,
      isApprovalResendPending,
      approvalDescription: approvalDescriptionRef.current,
      approvalSubjects,
      approvalDisplay: approvalDisplayConfig,
      truncation,
      continueTruncation,
      dismissTruncation,
      mentionQuery,
      mentionTrigger,
      mentionResults,
      setMentionSearch,
      clearMentionSearch,
      selectMention,
      activeMentions,
      addActiveMention,
      removeActiveMention,
      clearActiveMentions,
      isMentionSearching,
      hasMentions: !!mentions,
      completionSearch,
      hasCompletions: completionSearch !== undefined,
      triggers,
      composer: composerConfig,
      onCompletionSelect,
      mentionPrefix,
      drafts,
      interactions: interactionRegistry,
      pendingCommand,
      submitPendingCommand,
      cancelPendingCommand,
      runEntityAction,
      mentionEntity,
      composerMentions,
      consumeComposerMentions,
      suggestionChips,
      selectSuggestion,
      refreshSuggestions,
      isSuggestionsGenerating,
      sessions,
      activeSessionId,
      sessionsSupported,
      isSessionsLoading,
      switchSession,
      createSession,
      removeSession,
      renameSession,
      refreshSessions,
      entityDeclarations: declarations,
      language: language ?? undefined,
    }),
    [
      declarations,
      language,
      classNames,
      components,
      locale,
      themeVars,
      themeEffect,
      unstyled,
      suggestionsConfig,
      toolLabels,
      toolResultConfig,
      activityLogConfig,
      approvalSubjects,
      approvalDisplayConfig,
      toolRendererRegistry,
      attachmentOptions,
      voiceConfig,
      mentions,
      pipelineMessageTranslator,
      stepSummaryFormatter,
      visibleMessages,
      isLoading,
      awaitedOutcomes,
      sessionNotReady,
      isSessionMutating,
      isBootstrapSentinel,
      error,
      approvalError,
      send,
      submit,
      submitWithResult,
      lastRejection,
      queueEnabled,
      queueState,
      sendNow,
      removeQueued,
      editQueued,
      beginEdit,
      cancelEdit,
      clearQueue,
      resumeQueue,
      pauseQueue,
      stop,
      clear,
      loadMore,
      hasMore,
      pipelineSteps,
      pipelineState,
      turnOutcomes,
      pendingApprovals,
      approvalReminder,
      approve,
      reject,
      processingApprovalIds,
      isApprovalResendPending,
      truncation,
      continueTruncation,
      dismissTruncation,
      mentionQuery,
      mentionTrigger,
      mentionResults,
      setMentionSearch,
      clearMentionSearch,
      selectMention,
      activeMentions,
      addActiveMention,
      removeActiveMention,
      clearActiveMentions,
      isMentionSearching,
      completionSearch,
      triggers,
      composerConfig,
      onCompletionSelect,
      mentionPrefix,
      drafts,
      interactionRegistry,
      pendingCommand,
      submitPendingCommand,
      cancelPendingCommand,
      runEntityAction,
      mentionEntity,
      composerMentions,
      consumeComposerMentions,
      suggestionChips,
      selectSuggestion,
      refreshSuggestions,
      isSuggestionsGenerating,
      sessions,
      activeSessionId,
      sessionsSupported,
      isSessionsLoading,
      switchSession,
      createSession,
      removeSession,
      renameSession,
      refreshSessions,
    ],
  );

  return (
    <ChatContext.Provider value={contextValue}>
      <ChatComposerQueueProvider onOpenRequest={onOpenRequest}>
        <ChatEntityLinksProvider config={entityLinks} uiActionBus={uiActionBus}>
          <ChatMarkdownOptionsContext.Provider value={markdown ?? NO_MARKDOWN_OPTIONS}>
            {children}
          </ChatMarkdownOptionsContext.Provider>
        </ChatEntityLinksProvider>
      </ChatComposerQueueProvider>
    </ChatContext.Provider>
  );
}
