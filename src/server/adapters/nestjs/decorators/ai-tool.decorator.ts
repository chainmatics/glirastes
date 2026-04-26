import 'reflect-metadata';
import { AI_TOOL_METADATA, AI_TOOL_METHODS_METADATA } from './constants.js';
import type { AiToolOptions, AiToolMeta } from '../metadata.js';

/**
 * Method decorator that exposes a controller method as an AI tool.
 */
export function AiTool(options: AiToolOptions): MethodDecorator {
  return (target, propertyKey, _descriptor) => {
    const methodName = String(propertyKey);
    const meta: AiToolMeta = { ...options, methodName };

    // Store per-method metadata
    Reflect.defineMetadata(AI_TOOL_METADATA, meta, target, propertyKey);

    // Maintain array of decorated method names on the class
    const existingTools: string[] =
      Reflect.getMetadata(AI_TOOL_METHODS_METADATA, target.constructor) ?? [];
    if (!existingTools.includes(methodName)) {
      existingTools.push(methodName);
    }
    Reflect.defineMetadata(
      AI_TOOL_METHODS_METADATA,
      existingTools,
      target.constructor,
    );
  };
}
