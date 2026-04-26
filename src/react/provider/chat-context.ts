import { createContext, useContext } from 'react';
import type { CSSProperties } from 'react';
import type {
  ChatMessage,
  PendingApproval,
  MentionResult,
  MentionData,
  MentionConfig,
  ChatClassNames,
  ChatComponents,
  ChatLocale,
  SuggestionsConfig,
  TruncationInfo,
  ToolResultDisplayConfig,
  ToolLabelConfig,
  VoiceInputConfig,
  PipelineStepReport,
  PipelineState,
  PipelineMessageTranslator,
  StepSummaryFormatter,
  SessionSummary,
} from '../types.js';

type MentionTrigger = '@' | '/' | null;

export interface ChatContextValue {
  // Config
  classNames: ChatClassNames;
  components: ChatComponents;
  locale: ChatLocale;
  /**
   * Resolved theme vars (CSS custom properties). Spread this onto the
   * `style` prop of any widget root (`data-component="ai-chat-panel"`,
   * `chat-window`, `ai-trigger-button`) to apply the `theme` prop.
   */
  themeVars: CSSProperties;
  /**
   * Optional hint for themes that require special CSS treatment (e.g.
   * `liquid-glass` needs `backdrop-filter`). Apply as
   * `data-theme-effect={themeEffect}` on widget roots.
   */
  themeEffect: string | undefined;
  suggestions: SuggestionsConfig;
  toolLabels: ToolLabelConfig;
  toolResults: ToolResultDisplayConfig;
  voice: VoiceInputConfig;
  mentionConfig?: MentionConfig;
  pipelineMessageTranslator?: PipelineMessageTranslator;
  stepSummaryFormatter?: StepSummaryFormatter;

  // Chat state
  messages: ChatMessage[];
  isLoading: boolean;
  error: Error | null;
  send: (message: string) => void;
  stop: () => void;
  clear: () => void;
  loadMore: () => void;
  hasMore: boolean;
  pipelineSteps: PipelineStepReport[];
  pipelineState: PipelineState | null;

  // Approvals
  pendingApprovals: PendingApproval[];
  approve: (id: string) => void;
  reject: (id: string) => void;
  isProcessingApproval: boolean;
  approvalDescription: (toolName: string, approvalId: string, args: unknown) => PendingApproval;

  // Truncation
  truncation: TruncationInfo | null;
  continueTruncation: () => void;
  dismissTruncation: () => void;

  // Mentions
  mentionQuery: string;
  mentionTrigger: MentionTrigger;
  mentionResults: MentionResult[];
  setMentionSearch: (query: string, trigger: MentionTrigger) => void;
  clearMentionSearch: () => void;
  selectMention: (result: MentionResult) => void;
  activeMentions: MentionData[];
  addActiveMention: (mention: MentionData) => void;
  removeActiveMention: (mentionId: string) => void;
  clearActiveMentions: () => void;
  isMentionSearching: boolean;
  hasMentions: boolean;

  // Suggestions
  suggestionChips: string[];
  selectSuggestion: (suggestion: string) => void;
  refreshSuggestions: () => void;
  isSuggestionsGenerating: boolean;

  // Multi-session
  /** All known sessions; empty when the consumer does not supply `session.list`. */
  sessions: SessionSummary[];
  /** Currently-active session id. Defaults to `'default'` when no session config is given. */
  activeSessionId: string;
  /** `true` when the consumer provided `list`, `create`, and `remove`. */
  sessionsSupported: boolean;
  /** `true` while session CRUD or loading is in flight. */
  isSessionsLoading: boolean;
  /** Switch to an existing session. Reloads messages from `session.load`. */
  switchSession: (id: string) => Promise<void>;
  /** Create a new session, switch to it, refresh the list. */
  createSession: (opts?: { title?: string }) => Promise<SessionSummary | null>;
  /** Remove a session. If it was active, falls back to the first remaining session. */
  removeSession: (id: string) => Promise<void>;
  /** Rename a session. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Manually re-fetch the session list (e.g. after external mutation). */
  refreshSessions: () => Promise<void>;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error(
      'useChatContext must be used within an <AiChatProvider>',
    );
  }
  return context;
}
