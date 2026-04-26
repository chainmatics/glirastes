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
  FollowupsConfig,
  PipelineResult,
} from './types.js';
