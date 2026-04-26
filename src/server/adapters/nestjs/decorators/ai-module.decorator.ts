import 'reflect-metadata';
import { AI_MODULE_METADATA } from './constants.js';
import type { AiModuleOptions } from '../metadata.js';

/**
 * Class decorator that marks a NestJS controller as an AI intent module.
 */
export function AiModule(options: AiModuleOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AI_MODULE_METADATA, options, target);
  };
}
