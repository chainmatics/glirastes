import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AI_CHAT_MODULE_OPTIONS,
  type AiChatModuleOptions,
} from './ai-chat-module-options.interface.js';

@Injectable()
export class AiChatAuthGuard implements CanActivate {
  private guardInstance: CanActivate | null = null;

  constructor(
    @Inject(AI_CHAT_MODULE_OPTIONS)
    private readonly options: AiChatModuleOptions | null,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.options) {
      return false;
    }
    if (!this.guardInstance) {
      this.guardInstance = await this.moduleRef.create(this.options.authGuard);
    }
    return this.guardInstance.canActivate(context) as Promise<boolean>;
  }
}
