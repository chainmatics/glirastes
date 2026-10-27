import { Module, type DynamicModule } from '@nestjs/common';
import { SessionGuard } from './auth/session.guard.js';
import { ChatController } from './chat/chat.controller.js';
import { CHAT_OPTIONS, type ChatOptions } from './chat/chat.options.js';
import { TasksController } from './tasks/tasks.controller.js';

@Module({ controllers: [TasksController, ChatController], providers: [SessionGuard] })
export class AppModule {
  static with(options: ChatOptions): DynamicModule {
    return { module: AppModule, providers: [{ provide: CHAT_OPTIONS, useValue: options }] };
  }
}
