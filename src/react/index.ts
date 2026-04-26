// ============================================================================
// glirastes/react
//
// React components, hooks, and provider for AI chat UI.
// Styling-neutral: uses className props and data-* attributes.
// ============================================================================

// Types
export type {
  // Messages
  ChatMessage,
  MessagePart,
  TextPart,
  ToolInvocationPart,
  ToolResultPart,
  // Truncation
  TruncationInfo,
  PipelineStepUsage,
  PipelineStepReport,
  PipelineStatus,
  PipelineState,
  // Mentions
  MentionResult,
  MentionData,
  MentionConfig,
  MentionSerializationConfig,
  // Session
  SessionConfig,
  SessionSummary,
  WireChatMessage,
  // Theme
  ChatTheme,
  ChatThemePreset,
  ChatThemeOverride,
  ChatThemeColors,
  ChatLocale,
  // Size
  ChatSize,
  ChatSizePreset,
  // Suggestions
  SuggestionsConfig,
  // Tool labels
  ToolLabelConfig,
  ToolResultDisplayMode,
  ToolResultDisplayConfig,
  VoiceInputConfig,
  // Mention chips
  Mention,
  MentionChipProps,
  MentionChipListProps,
  // Styling
  ChatClassNames,
  ChatComponents,
  // Callbacks
  OnBeforeSend,
  OnToolResult,
  ApprovalDescriptionFn,
  PipelineMessageTranslator,
  StepSummaryFormatter,
  // Provider
  AiChatProviderConfig,
  // Hook returns
  UseAiChatReturn,
  PendingApproval,
  UseApprovalsReturn,
  UseMentionsReturn,
  UseSuggestionsReturn,
  // Component props
  AiChatPanelProps,
  MessageListProps,
  MessageBubbleProps,
  ChatInputProps,
  MentionInputProps,
  RichMentionInputHandle,
  RichMentionInputProps,
  RichMentionInputComponents,
  MentionDropdownItemProps,
  ChatWindowHeaderRenderProps,
  ChatWindowProps,
  ApprovalCardProps,
  BulkApprovalCardProps,
  PipelineTimelineProps,
  SuggestionChipProps,
  SuggestionBarProps,
  AiTriggerButtonProps,
  ToolResultBlockProps,
  MarkdownProps,
  // Transport
  ChatTransport,
  ChatTransportConfig,
  ChatTransportDataPart,
  ChatTransportDataHandler,
  ChatTransportApprovalResponse,
} from './types.js';

export type {
  UseDeepgramTranscriptionOptions,
  UseDeepgramTranscriptionReturn,
  VoiceInputButtonProps,
  RecordingBarProps,
} from './types.js';

// Provider
export { AiChatProvider, type AiChatProviderProps } from './provider/ai-chat-provider.js';

// Context (for advanced use cases)
export { useChatContext } from './provider/chat-context.js';
export type { ChatContextValue } from './provider/chat-context.js';

// Hooks
export { useAiChat } from './hooks/use-ai-chat.js';
export { useApprovals } from './hooks/use-approvals.js';
export { useMentions } from './hooks/use-mentions.js';
export { useSuggestions } from './hooks/use-suggestions.js';
export { useDeepgramTranscription } from './hooks/use-deepgram-transcription.js';
export { useDragResizePanel } from './hooks/use-drag-resize-panel.js';
export type {
  UseDragResizePanelOptions,
  UseDragResizePanelReturn,
  ResizeEdge,
} from './hooks/use-drag-resize-panel.js';
export { useDraggablePosition } from './hooks/use-draggable-position.js';
export { useKeyboardShortcut } from './hooks/use-keyboard-shortcut.js';
export type { UseKeyboardShortcutOptions } from './hooks/use-keyboard-shortcut.js';
export type {
  UseDraggablePositionOptions,
  UseDraggablePositionReturn,
} from './hooks/use-draggable-position.js';

// Components
export { AiChatPanel } from './components/ai-chat-panel.js';
export { FloatingChatUI, type FloatingChatUIProps } from './components/floating-chat-ui.js';
export { MessageList } from './components/message-list.js';
export { MessageBubble } from './components/message-bubble.js';
export { ChatInput } from './components/chat-input.js';
export { MentionInput } from './components/mention-input.js';
export { RichMentionInput } from './components/rich-mention-input.js';
export { ChatWindow } from './components/chat-window.js';
export { ApprovalCard } from './components/approval-card.js';
export { BulkApprovalCard } from './components/bulk-approval-card.js';
export { PipelineTimeline } from './components/pipeline-timeline.js';
export { SuggestionChip } from './components/suggestion-chip.js';
export { SuggestionBar } from './components/suggestion-bar.js';
export { MentionChip, MentionChipList } from './components/mention-chip.js';
export { VoiceInputButton } from './components/voice-input-button.js';
export { RecordingBar } from './components/recording-bar.js';
export { AiTriggerButton } from './components/ai-trigger-button.js';
export { SessionSwitcher, type SessionSwitcherProps } from './components/session-switcher.js';

// Bridges
export {
  createRestSessionBridge,
  type RestSessionBridgeOptions,
  type HeadersResolver,
} from './bridges/rest-session-bridge.js';

// Theme helpers
export { getThemeVars, CHAT_THEME_PRESETS, DEFAULT_THEME_PRESET } from './themes.js';

// Utilities
export { mergePipelineSteps } from './utils/merge-pipeline-steps.js';
export { sanitizeStoredMessages } from './utils/sanitize-stored-messages.js';
export {
  stripContextBlocks,
  parseMentionSegments,
  serializeMentionsForSend,
  inferMentionPrefix,
  normalizeMentionSlug,
} from './utils/mention-markup.js';
export {
  createToolResultHandler,
  type ToolResultHandlerConfig,
} from './utils/create-tool-result-handler.js';
export {
  createApprovalDescriptionGenerator,
  type ApprovalDescriptionConfig,
} from './utils/create-approval-description.js';

// UI action bus + hooks (client action dispatch)
export * from './ui.js';

// Pre-styled template (Tailwind wrappers around the unstyled components)
export * from './template.js';
