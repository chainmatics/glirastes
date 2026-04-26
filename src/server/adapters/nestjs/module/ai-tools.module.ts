import { AiToolsExplorerService } from './ai-tools-explorer.service.js';
import { AiToolsService } from './ai-tools.service.js';

export interface AiToolsModuleOptions {
  controllers?: Function[];
  global?: boolean;
}

/**
 * Configuration factory for NestJS module registration.
 *
 * Usage in a NestJS module:
 * ```ts
 * import { Module } from '@nestjs/common';
 * import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
 * import { createAiToolsProviders } from '../index.js';
 *
 * @Module({
 *   imports: [DiscoveryModule],
 *   providers: [...createAiToolsProviders()],
 *   exports: [AiToolsService],
 * })
 * export class AiToolsModule {}
 * ```
 */
export function createAiToolsProviders(options?: AiToolsModuleOptions) {
  return {
    options: options ?? {},
    ExplorerService: AiToolsExplorerService,
    ToolsService: AiToolsService,

    /**
     * Factory function to create the explorer service with NestJS DI.
     * Call this in a custom provider factory.
     */
    createExplorer(discoveryService: unknown, reflector: unknown) {
      const explorer = new AiToolsExplorerService(
        discoveryService,
        reflector,
        options,
      );
      explorer.explore();
      return explorer;
    },

    /**
     * Factory function to create the tools service.
     */
    createService(explorer: AiToolsExplorerService) {
      return new AiToolsService(explorer);
    },
  };
}
