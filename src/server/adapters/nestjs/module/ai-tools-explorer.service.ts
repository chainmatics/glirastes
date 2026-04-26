import 'reflect-metadata';
import type {
  AiEndpointToolDefinition,
  IntentModule,
  ModuleMeta,
  EndpointMethod,
} from '../../../../types.js';
import { z } from 'zod';
import { getAiModuleMeta, getAllAiTools, type AiModuleMeta, type AiToolMeta } from '../metadata.js';
import { buildZodSchemaFromDto, hasAiRelevantMeta, extractRouteParams } from '../scanner/schema-builder.js';

const HTTP_METHOD_MAP: Record<number, EndpointMethod> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
};

interface DiscoveredController {
  controllerClass: Function;
  moduleMeta: AiModuleMeta;
  tools: Array<AiToolMeta & { module: string }>;
}

/**
 * Discovers AI-decorated controllers at runtime using NestJS DiscoveryService.
 * Injectable as a NestJS provider.
 */
export class AiToolsExplorerService {
  private readonly discovered: DiscoveredController[] = [];
  private readonly endpointToolDefs: AiEndpointToolDefinition[] = [];
  private readonly intentModules = new Map<string, IntentModule>();

  constructor(
    private readonly discoveryService: unknown,
    private readonly reflector: unknown,
    private readonly options?: { controllers?: Function[] },
  ) {}

  /**
   * Called during module initialization to scan all controllers.
   */
  explore(): void {
    this.scanControllers();
    this.buildToolDefinitions();
    this.buildIntentModules();
  }

  private scanControllers(): void {
    const ds = this.discoveryService as {
      getControllers: () => Array<{ metatype: Function | undefined }>;
    };
    const controllers = ds.getControllers();

    for (const wrapper of controllers) {
      const controllerClass = wrapper.metatype;
      if (!controllerClass) continue;

      const moduleMeta = getAiModuleMeta(controllerClass);
      if (!moduleMeta) continue;

      if (
        this.options?.controllers &&
        !this.options.controllers.includes(controllerClass)
      ) {
        continue;
      }

      const tools = getAllAiTools(controllerClass);
      this.discovered.push({
        controllerClass,
        moduleMeta,
        tools: tools.map((t) => ({
          ...t,
          module: t.module ?? moduleMeta.intent,
        })),
      });
    }
  }

  private buildToolDefinitions(): void {
    const ref = this.reflector as {
      get: <T>(key: string, target: unknown) => T | undefined;
    };

    for (const ctrl of this.discovered) {
      const controllerPath =
        ref.get<string>('path', ctrl.controllerClass) ?? '';

      for (const tool of ctrl.tools) {
        const httpMethodNum = ref.get<number>(
          'method',
          ctrl.controllerClass.prototype[tool.methodName],
        );
        const httpMethod: EndpointMethod =
          (tool.method as EndpointMethod) ??
          HTTP_METHOD_MAP[httpMethodNum ?? 0] ??
          'GET';

        const methodPath =
          ref.get<string>(
            'path',
            ctrl.controllerClass.prototype[tool.methodName],
          ) ?? '';

        const fullPath =
          `/api/${controllerPath}/${methodPath}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, '') || '/';

        // Resolve DTO
        const paramTypes: Function[] | undefined = Reflect.getMetadata(
          'design:paramtypes',
          ctrl.controllerClass.prototype,
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
        const pathParams = extractRouteParams(ctrl.controllerClass, tool.methodName);
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

        this.endpointToolDefs.push({
          id: `${ctrl.moduleMeta.intent}.${tool.name}`,
          toolName: tool.name,
          module: tool.module,
          sharedWith: tool.sharedWith,
          description: tool.description,
          method: httpMethod,
          path: fullPath,
          inputSchema,
          outputSchema: tool.outputSchema,
          needsApproval: tool.needsApproval,
          uiActionOnSuccess: tool.uiActionOnSuccess,
          uiPattern: tool.uiPattern,
        });
      }
    }
  }

  private buildIntentModules(): void {
    for (const ctrl of this.discovered) {
      const intent = ctrl.moduleMeta.intent;
      const toolNames = ctrl.tools.map((t) => t.name);
      const existing = this.intentModules.get(intent);

      if (existing) {
        existing.toolNames.push(...toolNames);
      } else {
        const meta: ModuleMeta = {
          classification: ctrl.moduleMeta.classification,
          execution: ctrl.moduleMeta.execution,
          systemPrompt: ctrl.moduleMeta.systemPrompt,
        };
        this.intentModules.set(intent, { type: intent, toolNames, meta });
      }
    }

    // Expand sharedWith
    for (const def of this.endpointToolDefs) {
      if (!def.sharedWith) continue;
      for (const sharedModule of def.sharedWith) {
        const mod = this.intentModules.get(sharedModule);
        if (mod && !mod.toolNames.includes(def.toolName)) {
          mod.toolNames.push(def.toolName);
        }
      }
    }
  }

  getEndpointToolDefinitions(): ReadonlyArray<AiEndpointToolDefinition> {
    return this.endpointToolDefs;
  }

  getIntentModules(): ReadonlyMap<string, IntentModule> {
    return this.intentModules;
  }

  getDiscoveredControllers(): ReadonlyArray<DiscoveredController> {
    return this.discovered;
  }
}
