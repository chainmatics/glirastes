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
} from './context-helpers.js';
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

// Re-export from server-node for convenience
export { createNextInternalApiCaller } from '../../core/index.js';

// Types
export type {
  WithAiToolOptions,
  AiToolRouteHandler,
  AiChatHandlerConfig,
  LoadTools,
  GuardrailResult,
  GuardrailHook,
  IntentRoutingResult,
  IntentRouter,
  StepLimitSource,
  StepUsage,
  PipelineStepReport,
  PipelineStreamStatus,
  PipelineStreamState,
  ExecuteToolOptions,
  ExecuteToolResult,
  // Re-exported from glirastes
  AiPipeline,
  ClarificationConfig,
  FollowupsConfig,
  PipelineResult,
  ManagedLocalRuntimeConfig,
  ResolveTurnSnapshotContext,
} from './types.js';
