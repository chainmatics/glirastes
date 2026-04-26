import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent } from 'react';

// ============================================================================
// Chat Transport — transport-agnostic interface for chat backends
// ============================================================================

/**
 * Data part emitted by the transport during streaming.
 * Used for pipeline reports, truncation, and custom data events.
 */
export interface ChatTransportDataPart {
  type: string;
  data: unknown;
}

/**
 * Callback that receives data parts from the transport during streaming.
 */
export type ChatTransportDataHandler = (dataPart: ChatTransportDataPart) => void;

/**
 * Approval response sent back to the transport.
 */
export interface ChatTransportApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

/**
 * The core transport interface that decouples AiChatProvider from any
 * specific streaming backend (Vercel AI SDK, SSE, WebSocket, LangGraph, etc.).
 *
 * Consumers provide a transport implementation to AiChatProvider via the
 * `transport` prop (required). Pick one of the bundled transports
 * (`useVercelAiChatTransport`, `useLangGraphChatTransport`) from their
 * dedicated subpaths, or implement this interface for a custom backend.
 *
 * @example
 * ```tsx
 * import { AiChatProvider } from 'glirastes/react';
 * import { useLangGraphChatTransport } from 'glirastes/react/langgraph';
 *
 * const transport = useLangGraphChatTransport({ endpoint: '/api/chat' });
 * <AiChatProvider transport={transport}>
 *   <MessageList />
 *   <ChatInput />
 * </AiChatProvider>
 * ```
 */
export interface ChatTransport {
  /** Current messages in the conversation */
  messages: ChatMessage[];
  /** Current transport status */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Current error, if any */
  error: Error | null;
  /** Send a user message */
  sendMessage(opts: { text: string }): Promise<void>;
  /** Stop the current generation */
  stop(): void;
  /** Replace the message list (for session restore, sanitization) */
  setMessages(messages: ChatMessage[]): void;
  /** Respond to a tool approval request */
  addToolApprovalResponse(response: ChatTransportApprovalResponse): void | PromiseLike<void>;
  /**
   * Subscribe to data parts emitted by the transport during streaming.
   * Returns an unsubscribe function. AiChatProvider calls this to wire
   * its internal pipeline/truncation handlers; consumers can also use it
   * for custom data-part processing.
   */
  subscribeToData?(handler: ChatTransportDataHandler): () => void;
}

/**
 * Configuration for transports that connect to an HTTP endpoint.
 * Used by VercelAiChatTransport and can be used by custom transports.
 */
export interface ChatTransportConfig {
  /** The chat API endpoint URL */
  endpoint: string;
  /** Static headers or a function that returns headers per request */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Callback for streaming data parts (pipeline reports, truncation, etc.) */
  onData?: ChatTransportDataHandler;
}

// ============================================================================
// Speech / Voice Input
// ============================================================================

export interface UseDeepgramTranscriptionOptions {
  language?: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  onInterimTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

export interface UseDeepgramTranscriptionReturn {
  isRecording: boolean;
  isConnecting: boolean;
  error: string | null;
  transcript: string;
  startRecording: () => Promise<void>;
  stopRecording: () => string;
}

export interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
  language?: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  onError?: (error: string) => void;
}

export interface RecordingBarProps {
  isConnecting: boolean;
  onCancel: () => void;
  onStop: () => void;
  variant: 'trigger' | 'inline';
  className?: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  createdAt?: Date;
}

export type MessagePart =
  | TextPart
  | ToolInvocationPart
  | ToolResultPart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolInvocationPart {
  type: 'tool-invocation';
  toolInvocationId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: 'partial-call' | 'call' | 'approval-requested' | 'output-available';
  result?: unknown;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolInvocationId: string;
  toolName: string;
  result: unknown;
}

// ============================================================================
// Truncation
// ============================================================================

export interface TruncationInfo {
  completedTools: string[];
  message: string;
}

export interface PipelineStepUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PipelineStepReport {
  stepNumber: number;
  finishReason: string;
  toolCalls: string[];
  toolResults: number;
  requiresApproval: boolean;
  pendingApprovals: number;
  summary: string;
  usage: PipelineStepUsage;
  createdAt: string;
}

export type PipelineStatus =
  | 'running'
  | 'completed'
  | 'safety-stop'
  | 'aborted'
  | 'error';

export interface PipelineState {
  status: PipelineStatus;
  totalSteps: number;
  finishReason?: string;
  maxSteps: number;
  stepLimitSource: 'explicit' | 'module' | 'safety';
  updatedAt: string;
  message?: string;
}

// ============================================================================
// Mention Types
// ============================================================================

export interface MentionResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface MentionData {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface MentionConfig {
  search: (query: string, type: string) => Promise<MentionResult[]>;
  resolve: (id: string, type: string) => Promise<MentionData>;
  types: string[];
  serialize?: MentionSerializationConfig;
}

export interface MentionSerializationConfig {
  enabled?: boolean;
  includeContextBlock?: boolean;
  contextLabel?: string;
}

// ============================================================================
// Session Persistence
// ============================================================================

/**
 * Lightweight summary of a chat session used by the built-in session
 * switcher and any consumer UI that needs to list sessions.
 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  messageCount?: number;
  status?: 'active' | 'archived' | string;
}

/**
 * A "wire" chat message — the shallow shape most backends persist
 * (single string body, flat role). Accepted by `SessionConfig.load`
 * alongside the full `ChatMessage` shape; the provider coerces it into
 * SDK messages automatically so consumer bridges don't have to map
 * `content → parts[0].text` themselves.
 */
export interface WireChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string | null;
  createdAt?: string | number | Date;
}

/**
 * Session persistence / multi-session hooks.
 *
 * The original single-session surface (`save`, `load`, `clear`) is still
 * supported — set `defaultActiveId` (or leave it unset for `'default'`)
 * and the SDK behaves exactly as before.
 *
 * To opt into multi-session: provide `list`, `create`, and `remove` (and
 * optionally `rename`). When all three are defined, `sessionsSupported`
 * on the chat context becomes `true` and the built-in `SessionSwitcher`
 * component renders.
 */
export interface SessionConfig {
  /** Persist messages for a session. Called after each message change. */
  save?: (conversationId: string, messages: ChatMessage[]) => void | Promise<void>;
  /**
   * Load previously-stored messages for a session. Called on mount and
   * on switch. Return either full SDK `ChatMessage`s (with `parts`) or
   * flat `WireChatMessage`s (with `content`) — the provider coerces
   * the wire shape automatically.
   */
  load?: (
    conversationId: string,
  ) =>
    | Array<ChatMessage | WireChatMessage>
    | null
    | Promise<Array<ChatMessage | WireChatMessage> | null>;
  /**
   * Clear stored messages for a session. The optional id is the session
   * being cleared; when omitted the consumer may treat it as "the active
   * session" (pre-existing single-session behavior).
   */
  clear?: (conversationId?: string) => void | Promise<void>;

  // ---- Multi-session surface (all optional) ----

  /** Fetch the list of sessions for the current user. */
  list?: () => Promise<SessionSummary[]>;
  /** Create a new session. The returned summary becomes the active session. */
  create?: (opts?: { title?: string }) => Promise<SessionSummary>;
  /** Delete / archive a session. */
  remove?: (conversationId: string) => Promise<void>;
  /** Rename a session. */
  rename?: (conversationId: string, title: string) => Promise<void>;

  /** Controlled active session id. When set, the consumer owns the state. */
  activeId?: string;
  /** Initial active session id in uncontrolled mode. Default: `'default'`. */
  defaultActiveId?: string;
  /** Fires when the active session changes (both controlled and uncontrolled). */
  onActiveIdChange?: (id: string) => void;
}

// ============================================================================
// Mention Chip Types (chat-react–specific, not in contracts)
// ============================================================================

export interface Mention {
  id: string;
  type: string;
  displayName: string;
  slug?: string;
  prefix?: string;
  [key: string]: unknown;
}

// ============================================================================
// Tool Label Config
// ============================================================================

export interface ToolLabelConfig {
  labels?: Record<string, { singular: string; plural: string }>;
}

export type ToolResultDisplayMode = 'default' | 'hidden' | 'allowlist';

export interface ToolResultDisplayConfig {
  mode?: ToolResultDisplayMode;
  allowlist?: string[];
}

export interface VoiceInputConfig {
  enabled?: boolean;
  language?: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  recordingBar?: {
    enabled?: boolean;
    variant?: 'trigger' | 'inline';
  };
  onError?: (error: string) => void;
}

// ============================================================================
// Suggestion Types
// ============================================================================

export interface SuggestionsConfig {
  enabled?: boolean;
  count?: number;
  autoSuggest?: boolean;
  staticChips?: string[];
  rotationInterval?: number;
}

// ============================================================================
// ClassNames
// ============================================================================

export interface ChatClassNames {
  panel?: string;
  messageList?: string;
  messageBubble?: string;
  input?: string;
  approvalCard?: string;
  suggestionChip?: string;
  mentionChip?: string;
  bulkApprovalCard?: string;
  pipelineTimeline?: string;
  /**
   * The floating chat window `<section>`. Set this to apply Tailwind
   * classes for sizing, background, border, shadow, etc. When set,
   * the SDK's inline width/height styles are dropped so your class
   * wins — e.g. `classNames={{ window: 'w-[500px] h-[400px] bg-slate-900' }}`.
   */
  window?: string;
  /** The draggable header bar at the top of the chat window. */
  windowHeader?: string;
  /** The scrollable body region that wraps `<AiChatPanel />`. */
  windowBody?: string;
  /** The floating trigger pill (outer portal wrapper). */
  trigger?: string;
  /** The pill-shaped button inside the trigger. */
  triggerPill?: string;
  /** The session switcher dropdown root. */
  switcher?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// Component Overrides
// ============================================================================

export interface ChatComponents {
  MessageBubble?: ComponentType<MessageBubbleProps>;
  ChatInput?: ComponentType<ChatInputProps>;
  ToolResultBlock?: ComponentType<ToolResultBlockProps>;
  Markdown?: ComponentType<MarkdownProps>;
  InputExtra?: ComponentType<Record<string, never>>;
  ApprovalCard?: ComponentType<ApprovalCardProps>;
  BulkApprovalCard?: ComponentType<BulkApprovalCardProps>;
  PipelineTimeline?: ComponentType<PipelineTimelineProps>;
  SuggestionChip?: ComponentType<SuggestionChipProps>;
  MentionChip?: ComponentType<MentionChipProps>;
}

// ============================================================================
// Locale (internal — English-only, not publicly configurable)
// ============================================================================

/**
 * All user-facing strings rendered by the SDK's built-in components.
 * Every key is overridable via `AiChatProviderConfig.locale` so consumers
 * can bind them to `next-intl`, `react-i18next`, or any other i18n stack.
 */
export interface ChatLocale {
  placeholder: string;
  sendButton: string;
  stopButton: string;
  clearButton: string;
  loadMoreButton: string;
  emptyState: string;
  errorMessage: string;
  approveButton: string;
  rejectButton: string;
  approveAllButton: string;
  rejectAllButton: string;
  continueButton: string;
  dismissButton: string;
  cancelButton: string;
  confirmButton: string;
  moreItemsLabel: string;
  allCountLabel: string;
  pipelineTitle: string;
  pipelineRunningLabel: string;
  pipelineCompletedLabel: string;
  pipelineSafetyStopLabel: string;
  pipelineAbortedLabel: string;
  pipelineErrorLabel: string;
  pipelineStepLabel: string;
  pipelineApprovalPendingLabel: string;

  // Floating widget / chat window chrome
  chatTitle: string;                 // default header title ("AI Assistant")
  closeChatAriaLabel: string;        // close button aria / tooltip
  clearChatAriaLabel: string;        // trash button aria / tooltip
  confirmClearPrompt: string;        // window.confirm() text
  triggerAriaLabel: string;          // floating pill aria
  micAriaLabel: string;
  stopRecordingAriaLabel: string;
  cancelRecordingAriaLabel: string;

  // Session switcher
  newChatLabel: string;              // "+ New chat" row + default new session title
  noSessionsLabel: string;           // empty state
  sessionsLoadingLabel: string;      // loading state
  deleteSessionAriaLabel: string;
  confirmDeleteSessionPrompt: string;
  renameSessionAriaLabel: string;
  renameSessionPlaceholder: string;
}

// ============================================================================
// Callback Types
// ============================================================================

/** Preprocess message text before sending */
export type OnBeforeSend = (text: string, mentions: MentionData[]) => string;

/** Called when a tool produces output — useful for app-specific dispatching */
export type OnToolResult = (toolName: string, result: unknown) => void;

/** Formats approval display for a given tool call */
export type ApprovalDescriptionFn = (
  toolName: string,
  approvalId: string,
  args: unknown,
) => PendingApproval;

/** Translates a pipeline state message (e.g. "Stopped by user.") before rendering. */
export type PipelineMessageTranslator = (message: string) => string;

/** Formats a pipeline step summary for display. Receives the full step for rich formatting. */
export type StepSummaryFormatter = (step: PipelineStepReport) => string;

// ============================================================================
// Provider Config
// ============================================================================

export interface AiChatProviderConfig {
  mentions?: MentionConfig;
  toolResults?: ToolResultDisplayConfig;
  voice?: VoiceInputConfig;
  session?: SessionConfig;
  classNames?: ChatClassNames;
  components?: ChatComponents;
  suggestions?: SuggestionsConfig;
  /**
   * Partial override for any user-facing string rendered by the SDK.
   * Omitted keys fall back to the built-in English defaults.
   *
   * ```tsx
   * const t = useTranslations('chat');
   * <LangGraphAiChat
   *   locale={{ sendButton: t('send'), placeholder: t('placeholder') }}
   * />
   * ```
   */
  locale?: Partial<ChatLocale>;
  /**
   * Theme for the floating widget: a preset name (autocompleted by your
   * editor) or an override object. Defaults to `'professional-lightblue'`.
   *
   * ```tsx
   * <LangGraphAiChat theme="professional-dark" />
   * <LangGraphAiChat theme={{ preset: 'minimal-white', colors: { primary: '#10b981' } }} />
   * ```
   */
  theme?: ChatTheme;
  onToolResult?: OnToolResult;
  onBeforeSend?: OnBeforeSend;
  approvalDescription?: ApprovalDescriptionFn;
  continueMessage?: string;
  toolLabels?: ToolLabelConfig;
  pipelineMessageTranslator?: PipelineMessageTranslator;
  stepSummaryFormatter?: StepSummaryFormatter;
}

// ============================================================================
// Theme
// ============================================================================

export type ChatThemePreset =
  | 'professional-lightblue'
  | 'professional-dark'
  | 'minimal-white'
  | 'vibrant-indigo'
  | 'terminal-green'
  | 'liquid-glass'
  | 'purple-haze'
  | 'blue-dream'
  | 'sunset-orange'
  | 'ocean-teal'
  | 'midnight-mono';

export interface ChatThemeColors {
  /** Accent color — send button, pill gradient start, active session row. */
  primary?: string;
  /** Second stop of the pill gradient + hover accents. */
  primarySoft?: string;
  /** Tinted background used for hover/active states. */
  primaryTint?: string;
  /** Chat panel background. */
  bg?: string;
  /** Secondary background — header strip, code blocks, suggestion chips. */
  bgMuted?: string;
  /** User message bubble background. */
  bubbleUser?: string;
  /** Assistant message bubble background. */
  bubbleAssistant?: string;
  /** Primary text color. */
  text?: string;
  /** Muted text (subtitles, timestamps). */
  textMuted?: string;
  /** Border color for separators, input, window edge. */
  border?: string;
  /** Danger color for delete actions and error banners. */
  danger?: string;
}

export interface ChatThemeOverride {
  /** Base preset to inherit. Defaults to `'professional-lightblue'`. */
  preset?: ChatThemePreset;
  colors?: ChatThemeColors;
  /** Large radius — chat window, pill. Default: `0.875rem`. */
  radius?: string;
  /** Small radius — bubbles, inputs, buttons. Default: `0.5rem`. */
  radiusSmall?: string;
  /** Font stack for the entire widget. */
  fontFamily?: string;
}

export type ChatTheme = ChatThemePreset | ChatThemeOverride;

// ============================================================================
// Size
// ============================================================================

/**
 * Chat window size. Pass a preset or a concrete `{ width, height }` pair.
 *
 * | Preset  | Width × Height |
 * |---------|----------------|
 * | `sm`    | 360 × 560      |
 * | `md`    | 420 × 640 (default) |
 * | `lg`    | 520 × 720      |
 * | `xl`    | 640 × 820      |
 * | `full`  | 100% of viewport (mobile-style) |
 */
export type ChatSizePreset = 'sm' | 'md' | 'lg' | 'xl' | 'full';

/**
 * A single dimension value for the chat window. Accepts:
 * - `number` — pixel count (e.g. `500`)
 * - CSS length string — `'500px'`, `'40vw'`, `'70vh'`, `'60%'`, `'32rem'`
 *
 * Viewport units (`vw`, `vh`, `%`) are resolved against the current
 * window and re-computed on resize, so the chat scales with the page.
 */
export type ChatDimension = number | string;

export type ChatSize =
  | ChatSizePreset
  | { width: ChatDimension; height: ChatDimension };

// ============================================================================
// Hook Return Types
// ============================================================================

export interface UseAiChatReturn {
  messages: ChatMessage[];
  send: (message: string) => void;
  stop: () => void;
  isLoading: boolean;
  error: Error | null;
  loadMore: () => void;
  hasMore: boolean;
  clear: () => void;
  pipelineSteps: PipelineStepReport[];
  pipelineState: PipelineState | null;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  messageId: string;
  /** Human-readable description of what the tool will do */
  description?: string;
  /** Detail lines (e.g. "Title: My Task", "Priority: High") */
  details?: string[];
  /** Confirm button text override */
  confirmText?: string;
}

export interface UseApprovalsReturn {
  pending: PendingApproval[];
  approve: (id: string) => void;
  reject: (id: string) => void;
  grouped: Map<string, PendingApproval[]>;
  approveGroup: (toolName: string) => void;
  rejectGroup: (toolName: string) => void;
  isProcessing: boolean;
}

export interface UseMentionsReturn {
  query: string;
  results: MentionResult[];
  select: (result: MentionResult) => void;
  activeMentions: MentionData[];
  isSearching: boolean;
}

export interface UseSuggestionsReturn {
  chips: string[];
  refresh: () => void;
  select: (suggestion: string) => void;
  isGenerating: boolean;
}

// ============================================================================
// Component Props
// ============================================================================

export interface AiChatPanelProps {
  className?: string;
  defaultOpen?: boolean;
  /**
   * Ephemeral assistant greeting shown only when the current session
   * has no messages. Purely presentational — never persisted. Disappears
   * the moment the user (or the agent) adds a real message.
   *
   * Use case: dashboards that want a "press button → chat opens with
   * a prompt" affordance without polluting the session history when
   * the user closes the window without sending anything.
   */
  welcomeMessage?: string;
}

export interface MessageListProps {
  className?: string;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  className?: string;
}

export interface ChatInputProps {
  className?: string;
  onSubmit?: (message: string) => void;
}

export interface MentionInputProps {
  className?: string;
  onSubmit?: (message: string) => void;
}

export interface RichMentionInputHandle {
  focus: () => void;
  clear: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  getMentions: () => MentionData[];
  addMention: (mention: MentionData) => void;
}

export interface MentionDropdownItemProps {
  result: MentionResult;
  isSelected: boolean;
  onClick: () => void;
}

export interface RichMentionInputComponents {
  DropdownItem?: ComponentType<MentionDropdownItemProps>;
}

export interface RichMentionInputProps {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onChange?: (nextValue: string) => void;
  onSubmit?: (message: string) => void;
  /** Search callback for mention autocomplete (BYOS). Return matching results for the given query and trigger character. */
  onSearch?: (query: string, trigger: string) => Promise<MentionResult[]> | MentionResult[];
  /** Mention data to render as inline chips on mount (e.g. pre-filled context from a detail view). */
  initialMentions?: MentionData[];
  /** Characters that open the autocomplete dropdown. Defaults to `['@', '/']`. */
  triggers?: string[];
  /** Component overrides for the autocomplete dropdown. */
  components?: RichMentionInputComponents;
}

export interface ChatWindowHeaderRenderProps {
  onClose: () => void;
  isDragging: boolean;
  onDragStart: (e: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

export interface ChatWindowProps {
  children: ReactNode;
  title?: string;
  /** Aria-label + tooltip for the default close button. */
  closeChatAriaLabel?: string;
  header?: ReactNode;
  /**
   * Extra nodes rendered between the title and the close button in the
   * default header. Ignored when `renderHeader` is provided.
   */
  headerActions?: ReactNode;
  /**
   * Replace the title node in the default header — e.g. to render a
   * session switcher dropdown. Ignored when `renderHeader` is provided.
   */
  headerTitle?: ReactNode;
  renderHeader?: (props: ChatWindowHeaderRenderProps) => ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  portal?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  draggable?: boolean;
  resizable?: boolean;
  constrainToViewport?: boolean;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  initialPosition?: { x: number; y: number };
  maxWidth?: number;
  maxHeight?: number;
  snapToCenter?: boolean;
  snapRadius?: number;
  edgeThreshold?: number;
  persistDimensions?: boolean | string;
  onPositionChange?: (pos: { x: number; y: number } | null) => void;
  onDimensionChange?: (size: { width: number; height: number }) => void;
  resizeHandleClassName?: string;
  snapIndicatorClassName?: string;
}

export interface ApprovalCardProps {
  approval: PendingApproval;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  className?: string;
  isProcessing?: boolean;
}

export interface BulkApprovalCardProps {
  toolName: string;
  approvals: PendingApproval[];
  onApproveAll: () => void;
  onRejectAll: () => void;
  className?: string;
  isProcessing?: boolean;
}

export interface PipelineTimelineProps {
  steps: PipelineStepReport[];
  pipelineState: PipelineState | null;
  isLoading: boolean;
  onStop: () => void;
  className?: string;
}

export interface SuggestionChipProps {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  isVisible?: boolean;
}

export interface SuggestionBarProps {
  className?: string;
}

export interface ToolResultBlockProps {
  toolName: string;
  result: unknown;
  className?: string;
}

export interface MarkdownProps {
  content: string;
  className?: string;
}

export interface MentionChipProps {
  mention: Mention;
  onRemove?: () => void;
  className?: string;
  compact?: boolean;
  inline?: boolean;
}

export interface MentionChipListProps {
  mentions: Mention[];
  onRemove?: (mentionId: string) => void;
  className?: string;
}

// ============================================================================
// AI Trigger Button
// ============================================================================

export interface AiTriggerButtonProps {
  /** Called when the main button area (Sparkles) is clicked */
  onClickChat: () => void;
  /** Called when the mic button is clicked */
  onClickMic: () => void;
  /** Whether voice is currently recording */
  isRecording?: boolean;
  /** Whether voice connection is being established */
  isConnecting?: boolean;
  /** Called when user stops recording (red circle) */
  onStopRecording?: () => void;
  /** Called when user cancels recording (X) */
  onCancelRecording?: () => void;
  /** Render portal into document.body. Default: true */
  portal?: boolean;
  /** Optional className override for the outer fixed container */
  className?: string;
  /** Optional className for the button pill itself (e.g. `ai-magic-button`) */
  buttonClassName?: string;
  /** Wrap the default-state button in custom chrome (ContextMenu, Tooltip, etc.) */
  renderWrapper?: (button: ReactElement) => ReactElement;
  /** Allow the button to be dragged to a custom position. Default: true */
  draggable?: boolean;
  /** SessionStorage key for persisting the dragged position. Set to false to disable. Default: 'ai-trigger-btn' */
  persistPosition?: string | false;
  /** ARIA label for the main button. Default: "AI Assistant" */
  ariaLabel?: string;
  /** ARIA label for the mic button. Default: "Start recording" */
  micAriaLabel?: string;
  /** ARIA label for stop recording. Default: "Stop recording" */
  stopAriaLabel?: string;
  /**
   * Render the mic zone on the pill. Default: `true`. Set to `false`
   * to render a single-icon trigger (just the sparkle / custom icon).
   */
  showMic?: boolean;
  /**
   * Replace the built-in sparkle with a custom icon node. Sized to
   * ~16×16 visually but can be anything (img, SVG, emoji, etc.).
   */
  icon?: ReactNode;
  /** ARIA label for cancel recording. Default: "Cancel recording" */
  cancelAriaLabel?: string;
}
