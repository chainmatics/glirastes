import type {
  AiEndpointToolDefinition,
  IntentModule,
  ToolContext,
  ToolRegistry,
} from '../../../../types.js';
import {
  endpointToolsToRegistry,
  toolsToAiTools,
  type ToolToAiToolOptions,
} from '../../../core/index.js';
import type { AiToolsExplorerService } from './ai-tools-explorer.service.js';

/**
 * Injectable service for accessing AI tool definitions at runtime.
 */
export class AiToolsService {
  constructor(private readonly explorer: AiToolsExplorerService) {}

  getEndpointTools(): ReadonlyArray<AiEndpointToolDefinition> {
    return this.explorer.getEndpointToolDefinitions();
  }

  getIntentModules(): ReadonlyMap<string, IntentModule> {
    return this.explorer.getIntentModules();
  }

  getToolsForIntent(intent: string): AiEndpointToolDefinition[] {
    const mod = this.explorer.getIntentModules().get(intent);
    if (!mod) return [];
    const toolNameSet = new Set(mod.toolNames);
    return this.explorer
      .getEndpointToolDefinitions()
      .filter((t) => toolNameSet.has(t.toolName)) as AiEndpointToolDefinition[];
  }

  buildToolRegistry(): ToolRegistry {
    return endpointToolsToRegistry(
      this.explorer.getEndpointToolDefinitions() as AiEndpointToolDefinition[],
    );
  }

  async buildAiTools(context: ToolContext, options?: ToolToAiToolOptions) {
    const registry = this.buildToolRegistry();
    return toolsToAiTools(registry, context, options);
  }

  async buildAiToolsForIntent(
    intent: string,
    context: ToolContext,
    options?: ToolToAiToolOptions,
  ) {
    const tools = this.getToolsForIntent(intent);
    const registry = endpointToolsToRegistry(tools);
    return toolsToAiTools(registry, context, options);
  }
}
