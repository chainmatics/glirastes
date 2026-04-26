import 'reflect-metadata';
import {
  AI_MODULE_METADATA,
  AI_TOOL_METADATA,
  AI_TOOL_METHODS_METADATA,
  AI_PARAM_METADATA,
} from './decorators/constants.js';
import type {
  ModuleClassificationConfig,
  ModuleExecutionConfig,
  EndpointMethod,
  UiActionTemplate,
  UiPattern,
} from '../../../types.js';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiModuleOptions {
  intent: string;
  classification: ModuleClassificationConfig;
  execution?: Partial<ModuleExecutionConfig>;
  systemPrompt?: string;
}

export interface AiToolOptions {
  name: string;
  description: string;
  needsApproval?: boolean;
  sharedWith?: string[];
  uiActionOnSuccess?: UiActionTemplate;
  uiPattern?: UiPattern;
  method?: EndpointMethod;
  path?: string;
  /**
   * Optional Zod schema describing the tool's response shape.
   * When provided, a compact description is auto-appended to the tool description.
   */
  outputSchema?: z.ZodTypeAny;
}

export interface AiParamDescription {
  propertyKey: string;
  description: string;
}

export type AiModuleMeta = AiModuleOptions;

export interface AiToolMeta extends AiToolOptions {
  methodName: string;
}

// ---------------------------------------------------------------------------
// Metadata readers
// ---------------------------------------------------------------------------

export function getAiModuleMeta(
  controllerClass: Function,
): AiModuleMeta | undefined {
  return Reflect.getMetadata(AI_MODULE_METADATA, controllerClass);
}

export function getAiToolMeta(
  controllerClass: Function,
  methodName: string,
): AiToolMeta | undefined {
  return Reflect.getMetadata(
    AI_TOOL_METADATA,
    controllerClass.prototype,
    methodName,
  );
}

export function getAllAiToolNames(controllerClass: Function): string[] {
  return (
    Reflect.getMetadata(AI_TOOL_METHODS_METADATA, controllerClass) ?? []
  );
}

export function getAllAiTools(
  controllerClass: Function,
): Array<AiToolMeta & { module?: string }> {
  const moduleMeta = getAiModuleMeta(controllerClass);
  const toolNames = getAllAiToolNames(controllerClass);

  return toolNames
    .map((methodName) => {
      const toolMeta = getAiToolMeta(controllerClass, methodName);
      if (!toolMeta) return null;
      return { ...toolMeta, module: moduleMeta?.intent };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
}

export function getAiParamMeta(dtoClass: Function): AiParamDescription[] {
  return Reflect.getMetadata(AI_PARAM_METADATA, dtoClass) ?? [];
}
