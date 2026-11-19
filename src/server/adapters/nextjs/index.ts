export { withAiTool } from './with-ai-tool.js';
export {
  createAiChatHandler,
  type StreamHandlerContext,
  type AiChatHandlerFullConfig,
} from './create-ai-chat-handler.js';
export {
  extractOrigin,
  buildRuntimeContext,
  buildToolContext,
  createInternalApiCallerFromRequest,
  type OriginOptions,
} from './context-helpers.js';
export {
  createHideIdsTransform,
  redactIds,
  collectIdLabels,
  collectDeclaredIdLabels,
  HIDE_IDS_PROMPT,
  type IdLabels,
} from './hide-ids.js';
export {
  entityDeclarationsOfTools,
  TOOL_ENTITIES_PART_TYPE,
  type ToolEntitiesPart,
} from './tool-entities.js';
export {
  DEFAULT_BUDGET_STOP_TEXTS,
  type BudgetStopReason,
  type BudgetStopTexts,
} from './budget-stop-notice.js';
export { type ChatServerLocales, type ChatServerTexts } from './chat-texts.js';
export { sanitizeModelMessages } from './sanitize-model-messages.js';
export {
  prepareModelMessages,
  wrapToolsForVercelAi,
  type PrepareModelMessagesOptions,
} from './prepare-model-messages.js';
export { executeTool } from './server-action-helper.js';
export {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
export {
  applyClarificationResume,
  resolveClarificationResume,
  type ClarificationResume,
} from './clarification-resume.js';
export {
  createChatInteractionsHandler,
  type ChatInteractionsHandlerConfig,
} from './chat-interactions-handler.js';
export {
  createRecordingTranscriptionHandler,
  DEFAULT_RECORDING_LANGUAGES,
  type RecordingTranscriptionHandlerConfig,
} from './recording-transcription-handler.js';
export type { ApprovalStore, ApprovalDenialCode } from './approval-binding.js';
export {
  DEFAULT_APPROVAL_SUBJECT_LIMITS,
  type ApprovalSubjectLimits,
  type ApprovalSubjectRefusalCode,
} from './approval-subject-lookup.js';
export type { DefaultIntentRoutingOptions } from './default-intent-routing.js';
export type { HistoryOptions, HistoryTurnMode, ModelInputBreakdown } from './prepare-model-messages.js';
export type { SeenObject, SeenObjectsOptions } from './seen-objects.js';
export {
  contextWindowOf,
  type ChatCompactionOptions,
  type ChatMemoryConfig,
  type MemoryScopeKeys,
} from './chat-memory.js';
export {
  createInMemoryMemoryStore,
  verifyMemoryStore,
  type MemoryEntry,
  type MemoryScope,
  type MemoryStore,
} from '../../core/memory-store.js';
export {
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
  type DirectCommandRequest,
  type RunDirectCommandOptions,
} from './direct-command.js';
export {
  formatChatCommandMessage,
  parseChatCommandMessage,
  type ChatCommandInvocation,
} from '../../../contracts/chat-command.js';
export {
  chatText,
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatCommandData,
  type ChatEntityData,
  type ChatInteractionOverrides,
  type ChatInteractionsData,
} from '../../../contracts/chat-interactions.js';

// Re-export from server-node for convenience
export { createNextInternalApiCaller } from '../../core/index.js';

// Types
export type {
  WithAiToolOptions,
  AiToolRouteHandler,
  AiChatErrorInfo,
  AiChatHandlerConfig,
  ChatAttachmentsConfig,
  LoadTools,
  GuardrailResult,
  GuardrailHook,
  IntentRoutingResult,
  IntentRouter,
  StepLimitSource,
  StepUsage,
  PipelineStepReport,
  ModelInputEvent,
  PipelineStreamStatus,
  PipelineStreamState,
  ExecuteToolOptions,
  ExecuteToolResult,
  // Re-exported from glirastes
  AiPipeline,
  ClarificationConfig,
  PlanningConfig,
  FollowupsConfig,
  PipelineResult,
  ManagedLocalRuntimeConfig,
  ResolveTurnSnapshotContext,
} from './types.js';
