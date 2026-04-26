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
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  PendingApproval,
  MentionResult,
  MentionData,
  TruncationInfo,
  PipelineState,
  PipelineStepReport,
  SessionSummary,
} from '../types.js';
import { serializeMentionsForSend } from '../utils/mention-markup.js';
import { mergePipelineSteps } from '../utils/merge-pipeline-steps.js';

// ============================================================================
// Default locale (English)
// ============================================================================

import type { ChatLocale } from '../types.js';

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
  moreItemsLabel: 'more',
  allCountLabel: 'All {count}',
  pipelineTitle: 'Pipeline',
  pipelineRunningLabel: 'Running',
  pipelineCompletedLabel: 'Completed',
  pipelineSafetyStopLabel: 'Safety stop',
  pipelineAbortedLabel: 'Stopped',
  pipelineErrorLabel: 'Error',
  pipelineStepLabel: 'Step',
  pipelineApprovalPendingLabel: 'Approval pending',
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
  deleteSessionAriaLabel: 'Delete conversation',
  confirmDeleteSessionPrompt: 'Delete this conversation?',
  renameSessionAriaLabel: 'Rename conversation',
  renameSessionPlaceholder: 'Conversation title',
};

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

type MentionTrigger = '@' | '/' | null;

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

/** Default approval description — returns raw tool name and JSON args */
function defaultApprovalDescription(
  toolName: string,
  approvalId: string,
  args: unknown,
): PendingApproval {
  return {
    id: approvalId,
    toolName,
    args: isRecord(args) ? (args as Record<string, unknown>) : {},
    messageId: '',
    description: toolName,
  };
}

/**
 * Remove orphaned tool calls (approval-requested without response)
 * from message history to prevent AI_MissingToolResultsError.
 */
function sanitizeMessages<T extends { role: string; parts: unknown[] }>(msgs: T[]): T[] {
  return msgs.map((message) => {
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

    return { ...message, parts: sanitizedParts };
  }).filter((message) => {
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
      return hasContent || hasToolOutput || message.parts.length === 0;
    }
    return true;
  }) as T[];
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
    data.stepLimitSource !== 'safety'
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
export function AiChatProvider({
  transport,
  mentions,
  toolResults: userToolResults,
  voice: userVoice,
  session,
  classNames: userClassNames,
  components: userComponents,
  suggestions: userSuggestions,
  locale: userLocale,
  theme: userTheme,
  onToolResult,
  onBeforeSend,
  approvalDescription: userApprovalDescription,
  continueMessage = 'Please continue.',
  toolLabels: userToolLabels,
  pipelineMessageTranslator,
  stepSummaryFormatter,
  children,
}: AiChatProviderProps) {
  // Merge caller-supplied locale overrides with English defaults.
  const locale = useMemo<ChatLocale>(
    () => ({ ...DEFAULT_LOCALE, ...(userLocale ?? {}) }),
    [userLocale],
  );
  // Resolve `theme` prop → CSS variables spread onto widget roots.
  const themeVars = useMemo<CSSProperties>(
    () => getThemeVars(userTheme) as CSSProperties,
    [userTheme],
  );
  const themeEffect = useMemo(() => getThemeEffect(userTheme), [userTheme]);
  const classNames = useMemo(() => userClassNames ?? {}, [userClassNames]);
  const components = useMemo(() => userComponents ?? {}, [userComponents]);
  const suggestionsConfig = useMemo(
    () => ({ enabled: true, count: 3, autoSuggest: true, ...userSuggestions }),
    [userSuggestions],
  );
  const toolResultConfig = useMemo(
    () => ({ mode: 'default' as const, allowlist: [], ...userToolResults }),
    [userToolResults],
  );
  const voiceConfig = useMemo(
    () => ({
      enabled: false,
      language: 'de',
      recordingBar: { enabled: true, variant: 'inline' as const, ...(userVoice?.recordingBar ?? {}) },
      ...userVoice,
    }),
    [userVoice],
  );
  const toolLabels = useMemo(() => userToolLabels ?? {}, [userToolLabels]);

  const approvalDescriptionFn = userApprovalDescription ?? defaultApprovalDescription;

  // Approvals state (Map for O(1) lookup)
  const [pendingApprovalsMap, setPendingApprovalsMap] = useState<Map<string, PendingApproval>>(new Map());
  const [processingApprovalId, setProcessingApprovalId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

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
  const [isSessionsLoading, setIsSessionsLoading] = useState(false);

  const sessionsSupported = Boolean(
    session && session.list && session.create && session.remove,
  );

  // Keep a ref so callbacks inside effects read the current session config
  // without re-binding on every render.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Truncation
  const [truncation, setTruncation] = useState<TruncationInfo | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepReport[]>([]);
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);

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

  // Refs for deduplication
  const processedToolCallsRef = useRef<Set<string>>(new Set());
  const handledApprovalIdsRef = useRef<Set<string>>(new Set());

  // Stable refs for callbacks to avoid re-creating transport
  const onToolResultRef = useRef(onToolResult);
  onToolResultRef.current = onToolResult;
  const approvalDescriptionRef = useRef(approvalDescriptionFn);
  approvalDescriptionRef.current = approvalDescriptionFn;

  // Data part handler — processes pipeline and truncation events from any transport
  const handleDataPart = useCallback((dataPart: { type: string; data: unknown }) => {
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
      }
    }
  }, []);

  const resolvedTransport = transport;

  useEffect(() => {
    return resolvedTransport.subscribeToData?.(handleDataPart);
  }, [resolvedTransport, handleDataPart]);

  const {
    messages: rawMessages,
    sendMessage,
    status,
    error,
    stop: transportStop,
    setMessages,
    addToolApprovalResponse,
  } = resolvedTransport;

  const isLoading = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    if (!error) return;
    setPipelineState((prev) => ({
      status: 'error',
      totalSteps: prev?.totalSteps ?? pipelineSteps.length,
      finishReason: 'error',
      maxSteps: prev?.maxSteps ?? 1,
      stepLimitSource: prev?.stepLimitSource ?? 'safety',
      updatedAt: new Date().toISOString(),
      message: typeof error.message === 'string' ? error.message : 'Pipeline failed.',
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

  // Load messages from session whenever the active session changes.
  // Runs on mount and on every switchSession() call.
  useEffect(() => {
    const cfg = sessionRef.current;
    if (!cfg?.load) {
      if (!isInitialized) setIsInitialized(true);
      return;
    }

    // Don't try to load the bootstrap sentinel when multi-session mode is
    // active — `'default'` is unlikely to be a valid session id in the
    // consumer's backend, and the auto-select effect (below) will switch
    // us to the first real session as soon as `list()` resolves.
    const isBootstrapSentinel =
      activeSessionId === 'default' &&
      cfg.list !== undefined &&
      cfg.activeId === undefined;
    if (isBootstrapSentinel) {
      if (!isInitialized) setIsInitialized(true);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const loaded = await Promise.resolve(cfg.load!(activeSessionId));
        if (cancelled) return;
        processedToolCallsRef.current.clear();
        handledApprovalIdsRef.current.clear();
        // Coerce wire-shape rows (with `content: string`) into SDK
        // messages (with `parts: [...]`) so bridges don't have to.
        const coerced = loaded ? coerceLoadedMessages(loaded as unknown[]) : [];
        if (coerced.length > 0) {
          markStoredMessagesAsProcessed(coerced as unknown[]);
          const sanitized = sanitizeMessages(
            coerced as unknown as Array<{ role: string; parts: unknown[] }>,
          );
          setMessages(sanitized as unknown as typeof rawMessages);
        } else {
          setMessages([] as unknown as typeof rawMessages);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn(
          `[AiChatProvider] session.load("${activeSessionId}") failed:`,
          err,
        );
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
  }, [activeSessionId, setMessages, markStoredMessagesAsProcessed]);

  // Save messages to session on change (scoped to the active session).
  useEffect(() => {
    if (!isInitialized) return;
    if (rawMessages.length === 0) return;
    const cfg = sessionRef.current;
    if (!cfg?.save) return;
    void Promise.resolve(
      cfg.save(activeSessionId, rawMessages as unknown as ChatMessage[]),
    );
  }, [rawMessages, isInitialized, activeSessionId]);

  // Process tool results and approvals from streaming messages
  useEffect(() => {
    if (rawMessages.length === 0) return;

    const lastMessage = rawMessages[rawMessages.length - 1];
    if (lastMessage.role !== 'assistant') return;

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
          const pending = approvalDescriptionRef.current(toolName, toolPart.approval.id, toolPart.input);
          setPendingApprovalsMap(prev => new Map(prev).set(toolPart.approval!.id, pending));
        }

        // Tool result available — call onToolResult
        if (toolPart.state === 'output-available' && isRecord(toolPart.output)) {
          const toolCallId = toolPart.toolCallId || `${lastMessage.id}-${partType}`;
          if (!processedToolCallsRef.current.has(toolCallId)) {
            processedToolCallsRef.current.add(toolCallId);
            onToolResultRef.current?.(toolName, toolPart.output);
          }
        }
      }
    }
  }, [rawMessages]);

  // Extract suggestions from suggest_followups tool
  useEffect(() => {
    if (rawMessages.length === 0) return;

    const count = suggestionsConfig.count ?? 3;
    let latestFollowups: string[] | null = null;

    for (let messageIndex = rawMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = rawMessages[messageIndex];
      if (message.role !== 'assistant') continue;

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
          latestFollowups = followups.slice(0, count);
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
  const send = useCallback(async (message: string) => {
    // Clear truncation and suggestion chips on new message
    setTruncation(null);
    setSuggestionChips([]);
    setPipelineSteps([]);
    setPipelineState(null);

    // Preprocess message
    let processedMessage = message;
    const mentionSerializeConfig = mentions?.serialize;
    if (mentionSerializeConfig?.enabled !== false) {
      processedMessage = serializeMentionsForSend(
        processedMessage,
        activeMentions,
        mentionSerializeConfig,
      );
    }
    if (onBeforeSend) {
      processedMessage = onBeforeSend(processedMessage, activeMentions);
    }

    // Sanitize messages before sending to prevent AI_MissingToolResultsError
    const currentMessages = rawMessages;
    const sanitized = sanitizeMessages(currentMessages as unknown as Array<{ role: string; parts: unknown[] }>);
    if (sanitized.length !== currentMessages.length || JSON.stringify(sanitized) !== JSON.stringify(currentMessages)) {
      setMessages(sanitized as unknown as typeof rawMessages);
      setPendingApprovalsMap(new Map());
    }

    // Auto-reject pending approvals when user sends new message
    if (pendingApprovalsMap.size > 0) {
      const approvalIds = Array.from(pendingApprovalsMap.keys());
      setPendingApprovalsMap(new Map());
      for (const approvalId of approvalIds) {
        await addToolApprovalResponse({
          id: approvalId,
          approved: false,
          reason: 'Auto-rejected: user sent a new message.',
        });
      }
    }

    await sendMessage({ text: processedMessage });
    setActiveMentions([]);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setIsMentionSearching(false);
  }, [
    rawMessages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    pendingApprovalsMap,
    mentions,
    onBeforeSend,
    activeMentions,
  ]);

  const stop = useCallback(() => {
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
  }, [transportStop, pipelineSteps.length]);

  const clear = useCallback(() => {
    setMessages([]);
    void Promise.resolve(sessionRef.current?.clear?.(activeSessionId));
    processedToolCallsRef.current.clear();
    handledApprovalIdsRef.current.clear();
    setPendingApprovalsMap(new Map());
    setVisibleMessageCount(30);
    setTruncation(null);
    setPipelineSteps([]);
    setPipelineState(null);
    setMentionQuery('');
    setMentionTrigger(null);
    setMentionResults([]);
    setActiveMentions([]);
    setIsMentionSearching(false);
    setSuggestionChips(suggestionsConfig.staticChips ?? []);
  }, [setMessages, activeSessionId, suggestionsConfig.staticChips]);

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
        list.length > 0 &&
        cfg.activeId === undefined &&
        (uncontrolledActiveIdRef.current === 'default' ||
          !list.some((s) => s.id === uncontrolledActiveIdRef.current))
      ) {
        const next = list[0].id;
        setUncontrolledActiveId(next);
        cfg.onActiveIdChange?.(next);
      }
    } catch (err) {
      console.warn('[AiChatProvider] session.list failed:', err);
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
      if (id === activeSessionId) return;
      // Reset transient UI state before loading new session
      setPendingApprovalsMap(new Map());
      setTruncation(null);
      setPipelineSteps([]);
      setPipelineState(null);
      setSuggestionChips(suggestionsConfig.staticChips ?? []);
      setVisibleMessageCount(30);
      applyActiveId(id);
    },
    [activeSessionId, applyActiveId, suggestionsConfig.staticChips],
  );

  const createSession = useCallback(
    async (opts?: { title?: string }): Promise<SessionSummary | null> => {
      const cfg = sessionRef.current;
      if (!cfg?.create) return null;
      const created = await cfg.create(opts);
      await refreshSessions();
      await switchSession(created.id);
      return created;
    },
    [refreshSessions, switchSession],
  );

  const removeSession = useCallback(
    async (id: string) => {
      const cfg = sessionRef.current;
      if (!cfg?.remove) return;
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
    },
    [activeSessionId, switchSession],
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
  const allMessages = rawMessages as unknown as ChatMessage[];
  const consolidated = consolidateAssistantMessages(allMessages);
  const hasMore = consolidated.length > visibleMessageCount;
  const visibleMessages = hasMore
    ? consolidated.slice(-visibleMessageCount)
    : consolidated;

  const loadMore = useCallback(() => {
    setVisibleMessageCount(prev => prev + 10);
  }, []);

  // Approval handlers
  const approve = useCallback(async (id: string) => {
    setProcessingApprovalId(id);
    setPendingApprovalsMap(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    await addToolApprovalResponse({ id, approved: true });
    setProcessingApprovalId(null);
  }, [addToolApprovalResponse]);

  const reject = useCallback(async (id: string) => {
    setProcessingApprovalId(id);
    setPendingApprovalsMap(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    await addToolApprovalResponse({
      id,
      approved: false,
      reason: 'Rejected by user.',
    });
    setProcessingApprovalId(null);
  }, [addToolApprovalResponse]);

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
  const contextValue = useMemo<ChatContextValue>(
    () => ({
      classNames,
      components,
      locale,
      themeVars,
      themeEffect,
      suggestions: suggestionsConfig,
      toolLabels,
      toolResults: toolResultConfig,
      voice: voiceConfig,
      mentionConfig: mentions,
      pipelineMessageTranslator,
      stepSummaryFormatter,
      messages: visibleMessages,
      isLoading,
      error: error ?? null,
      send,
      stop,
      clear,
      loadMore,
      hasMore,
      pipelineSteps,
      pipelineState,
      pendingApprovals,
      approve,
      reject,
      isProcessingApproval: processingApprovalId !== null,
      approvalDescription: approvalDescriptionRef.current,
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
    }),
    [
      classNames,
      components,
      locale,
      themeVars,
      themeEffect,
      suggestionsConfig,
      toolLabels,
      toolResultConfig,
      voiceConfig,
      mentions,
      pipelineMessageTranslator,
      stepSummaryFormatter,
      visibleMessages,
      isLoading,
      error,
      send,
      stop,
      clear,
      loadMore,
      hasMore,
      pipelineSteps,
      pipelineState,
      pendingApprovals,
      approve,
      reject,
      processingApprovalId,
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
      {children}
    </ChatContext.Provider>
  );
}
