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
import type { CompletionSearch } from '../completions/completion-search.js';
import type { ChatInteractionRegistry, PendingChatCommand } from '../interactions/registry.js';
import type { ToolResultRendererRegistry } from '../tool-renderers/registry.js';

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
  /**
   * True when the provider runs without the shipped styles. Render
   * `data-unstyled={unstyled || undefined}` on widget roots.
   */
  unstyled: boolean;
  suggestions: SuggestionsConfig;
  toolLabels: ToolLabelConfig;
  toolResults: ToolResultDisplayConfig;
  /** Custom result components; absent when none are configured. */
  toolRendererRegistry?: ToolResultRendererRegistry;
  voice: VoiceInputConfig;
  mentionConfig?: MentionConfig;
  pipelineMessageTranslator?: PipelineMessageTranslator;
  stepSummaryFormatter?: StepSummaryFormatter;

  // Chat state
  messages: ChatMessage[];
  isLoading: boolean;
  error: Error | null;
  /**
   * `mentions` replaces the provider's active mentions for this message.
   * Returns false when the message is not taken (an approval is still open or
   * the session is not ready); the composer should then keep the typed text.
   */
  send: (message: string, options?: { mentions?: MentionData[] }) => boolean;
  stop: () => void;
  clear: () => void;
  loadMore: () => void;
  hasMore: boolean;
  pipelineSteps: PipelineStepReport[];
  pipelineState: PipelineState | null;

  // Approvals
  pendingApprovals: PendingApproval[];
  /**
   * True after the user tried to send while an approval waits. Sending is held
   * until the card is decided; show `locale.approvalPendingHint`.
   */
  approvalReminder: boolean;
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

  // Completion providers
  completionSearch?: CompletionSearch;
  hasCompletions: boolean;

  // Declarative chat interactions (`chatInteractions`)
  /** `@` entities and `/` commands; absent without `chatInteractions`. */
  interactions?: ChatInteractionRegistry;
  /** A command or entity action waiting for arguments; the composer shows its form. */
  pendingCommand: PendingChatCommand | null;
  /**
   * Runs the pending command with the form values (and picked entity labels), or keeps asking.
   * True when the form is done (the command was sent and no longer pending); false when
   * it is still pending (it keeps asking, or nothing could run right now).
   */
  submitPendingCommand: (
    values: Readonly<Record<string, string>>,
    valueLabels?: Readonly<Record<string, string>>,
  ) => boolean;
  cancelPendingCommand: () => void;
  /** Runs an entity action picked from the `@` list, without the model. */
  runEntityAction: (entity: { type: string; id: string; label: string }, actionId: string) => void;
  /**
   * Adds a reference to one entity to the composer, looked up by id through
   * its definition's `resolve`. False when the entity is unknown or refused.
   */
  mentionEntity: (type: string, id: string) => Promise<boolean>;
  /** References queued by `mentionEntity`, for the composer to insert. */
  composerMentions: MentionData[];
  consumeComposerMentions: () => void;

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
  /** Active generation or session mutation prevents changing the conversation. */
  isSessionChangeBlocked?: boolean;
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
