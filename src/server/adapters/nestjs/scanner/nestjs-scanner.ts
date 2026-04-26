import 'reflect-metadata';
import type {
  AiEndpointToolDefinition,
  IntentModule,
  ModuleMeta,
  EndpointMethod,
} from '../../../../types.js';
import { z } from 'zod';
import { getAiModuleMeta, getAllAiTools } from '../metadata.js';
import { buildZodSchemaFromDto, hasAiRelevantMeta, extractRouteParams } from './schema-builder.js';

export interface NestJsScanOptions {
  controllers: Function[];
  apiPrefix?: string;
}

export interface NestJsScanResult {
  tools: AiEndpointToolDefinition[];
  modules: IntentModule[];
  toolsByModule: Record<string, string[]>;
}

const HTTP_METHOD_MAP: Record<number, EndpointMethod> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
};

/**
 * Scan decorated NestJS controllers and produce tool/module definitions.
 * Works at build time without a running NestJS app.
 */
export function scanNestJsControllers(
  options: NestJsScanOptions,
): NestJsScanResult {
  const apiPrefix = options.apiPrefix ?? '/api';
  const allTools: AiEndpointToolDefinition[] = [];
  const moduleMap = new Map<string, IntentModule>();

  for (const controllerClass of options.controllers) {
    const moduleMeta = getAiModuleMeta(controllerClass);
    if (!moduleMeta) continue;

    const tools = getAllAiTools(controllerClass);
    const controllerPath: string =
      Reflect.getMetadata('path', controllerClass) ?? '';

    for (const tool of tools) {
      const methodPath: string =
        Reflect.getMetadata(
          'path',
          controllerClass.prototype[tool.methodName],
        ) ?? '';

      const fullPath =
        `${apiPrefix}/${controllerPath}/${methodPath}`
          .replace(/\/+/g, '/')
          .replace(/\/$/, '') || '/';

      // Resolve HTTP method
      const httpMethodNum: number | undefined = Reflect.getMetadata(
        'method',
        controllerClass.prototype[tool.methodName],
      );
      const httpMethod: EndpointMethod =
        (tool.method as EndpointMethod) ??
        HTTP_METHOD_MAP[httpMethodNum ?? 0] ??
        'GET';

      // Resolve DTO schema
      const paramTypes: Function[] | undefined = Reflect.getMetadata(
        'design:paramtypes',
        controllerClass.prototype,
        tool.methodName,
      );
      let inputSchema: z.ZodTypeAny = z.object({});
      if (paramTypes) {
        for (const pt of paramTypes) {
          if (pt && typeof pt === 'function' && hasAiRelevantMeta(pt)) {
            inputSchema = buildZodSchemaFromDto(pt);
            break;
          }
        }
      }

      // Merge path parameters into input schema
      const pathParams = extractRouteParams(controllerClass, tool.methodName);
      if (pathParams.length > 0) {
        const pathShape: Record<string, z.ZodTypeAny> = {};
        for (const paramName of pathParams) {
          if (!(inputSchema instanceof z.ZodObject) || !(paramName in (inputSchema as z.ZodObject<any>).shape)) {
            pathShape[paramName] = z.string().uuid().describe(`Path parameter: ${paramName}`);
          }
        }
        if (Object.keys(pathShape).length > 0) {
          inputSchema = inputSchema instanceof z.ZodObject
            ? (inputSchema as z.ZodObject<any>).extend(pathShape)
            : z.object(pathShape);
        }
      }

      allTools.push({
        id: `${moduleMeta.intent}.${tool.name}`,
        toolName: tool.name,
        module: tool.module ?? moduleMeta.intent,
        sharedWith: tool.sharedWith,
        description: tool.description,
        method: httpMethod,
        path: fullPath,
        inputSchema,
        needsApproval: tool.needsApproval,
        uiActionOnSuccess: tool.uiActionOnSuccess,
        uiPattern: tool.uiPattern,
      });
    }

    // Build IntentModule
    const intent = moduleMeta.intent;
    const toolNames = tools.map((t) => t.name);
    const existing = moduleMap.get(intent);
    if (existing) {
      existing.toolNames.push(...toolNames);
    } else {
      const meta: ModuleMeta = {
        classification: moduleMeta.classification,
        execution: moduleMeta.execution,
        systemPrompt: moduleMeta.systemPrompt,
      };
      moduleMap.set(intent, { type: intent, toolNames, meta });
    }
  }

  // Expand sharedWith
  const toolsByModule: Record<string, string[]> = {};
  for (const [intent, mod] of moduleMap) {
    toolsByModule[intent] = [...mod.toolNames];
  }
  for (const tool of allTools) {
    if (!tool.sharedWith) continue;
    for (const sharedModule of tool.sharedWith) {
      if (!toolsByModule[sharedModule]) {
        toolsByModule[sharedModule] = [];
      }
      if (!toolsByModule[sharedModule].includes(tool.toolName)) {
        toolsByModule[sharedModule].push(tool.toolName);
      }
    }
  }

  return {
    tools: allTools,
    modules: Array.from(moduleMap.values()),
    toolsByModule,
  };
}
