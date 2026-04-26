// Decorators
export { AiModule } from './decorators/ai-module.decorator.js';
export { AiTool } from './decorators/ai-tool.decorator.js';
export { AiParam } from './decorators/ai-param.decorator.js';

// Metadata readers
export {
  getAiModuleMeta,
  getAiToolMeta,
  getAllAiToolNames,
  getAllAiTools,
  getAiParamMeta,
} from './metadata.js';

// Types
export type {
  AiModuleOptions,
  AiToolOptions,
  AiModuleMeta,
  AiToolMeta,
  AiParamDescription,
} from './metadata.js';

// Module (DI)
export { AiToolsExplorerService } from './module/ai-tools-explorer.service.js';
export { AiToolsService } from './module/ai-tools.service.js';
export {
  createAiToolsProviders,
  type AiToolsModuleOptions,
} from './module/ai-tools.module.js';

// Build-time scanner
export {
  scanNestJsControllers,
  type NestJsScanOptions,
  type NestJsScanResult,
} from './scanner/nestjs-scanner.js';

// Schema builder
export { buildZodSchemaFromDto, hasAiRelevantMeta, extractRouteParams } from './scanner/schema-builder.js';

// Swagger / OpenAPI
export { applyAiExtensions } from './swagger.js';

// Chat module
export { AiChatModule } from './chat/ai-chat.module.js';
export type { AiChatModuleOptions, AiChatModuleAsyncOptions, AiChatModuleFeatures } from './chat/ai-chat-module-options.interface.js';
export { AiChatRequestDto, ChatMessageDto, ChatMessagePartDto } from './chat/dto/index.js';
