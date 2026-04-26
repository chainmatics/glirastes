import type { OpenApiAiExtension } from '../../../types.js';
import { getAiModuleMeta, getAllAiTools } from './metadata.js';

type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface OperationObject {
  'x-ai'?: OpenApiAiExtension;
  [key: string]: unknown;
}

type PathItem = Partial<Record<HttpMethod, OperationObject>>;

/**
 * Walks an OpenAPI document and merges `@AiTool` decorator metadata
 * into each matching operation as an `x-ai` extension.
 *
 * Mutates `document` in place.
 */
export function applyAiExtensions(
  document: Record<string, unknown>,
  controllers: Array<new (...args: unknown[]) => unknown>,
): void {
  const paths = document['paths'] as
    | Record<string, PathItem>
    | undefined;

  if (!paths) return;

  for (const controller of controllers) {
    const moduleMeta = getAiModuleMeta(controller);
    const tools = getAllAiTools(controller);

    for (const tool of tools) {
      const toolPath = tool.path;
      const toolMethod = tool.method?.toLowerCase() as HttpMethod | undefined;

      if (!toolPath || !toolMethod) continue;

      const pathItem = paths[toolPath];
      if (!pathItem) continue;

      const operation = pathItem[toolMethod];
      if (!operation) continue;

      const extension: OpenApiAiExtension = {
        enabled: true,
        toolName: tool.name,
        description: tool.description,
        needsApproval: tool.needsApproval,
        module: moduleMeta?.intent,
      };

      operation['x-ai'] = extension;
    }
  }
}
