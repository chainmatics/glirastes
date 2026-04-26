import 'reflect-metadata';
import { AI_PARAM_METADATA } from './constants.js';
import type { AiParamDescription } from '../metadata.js';

/**
 * Property decorator that adds an AI-readable description to a DTO property.
 */
export function AiParam(description: string): PropertyDecorator {
  return (target, propertyKey) => {
    const existing: AiParamDescription[] =
      Reflect.getMetadata(AI_PARAM_METADATA, target.constructor) ?? [];
    existing.push({ propertyKey: String(propertyKey), description });
    Reflect.defineMetadata(AI_PARAM_METADATA, existing, target.constructor);
  };
}
