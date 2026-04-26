import type {
  CanActivate,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import type { LanguageModel } from 'ai';
import type { AuditEmitter } from '../../../../types.js';
import type { Lancer } from '../../../lancer/index.js';

export const AI_CHAT_MODULE_OPTIONS = Symbol('AI_CHAT_MODULE_OPTIONS');

export interface AiChatModuleFeatures {
  speechToText?: boolean;
}

export interface AiChatModuleOptions {
  /** Vercel AI SDK LanguageModel — consumer creates and owns this */
  model: LanguageModel;

  /** Project-specific system prompt, static string or factory */
  systemPrompt: string | ((context: { currentDate: string }) => string);

  /** NestJS guard class for HTTP authentication */
  authGuard: Type<CanActivate>;

  /** Optional feature toggles */
  features?: AiChatModuleFeatures;

  /** Max tool-call steps per chat request (default: 4) */
  maxSteps?: number;

  /** Unified audit event callback for compliance logging */
  onAudit?: AuditEmitter;

  /** Lancer client for runtime prompt overrides (Pro feature) */
  lancer?: Lancer;
}

export interface AiChatModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  /** Factory that returns options or null to disable the module */
  useFactory: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => Promise<AiChatModuleOptions | null> | AiChatModuleOptions | null;
  /** Injection tokens to pass to useFactory */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
}
