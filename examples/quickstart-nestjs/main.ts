import { Module } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { openai } from '@ai-sdk/openai';
import { AiChatModule, scanNestJsControllers } from 'glirastes/server/nestjs';
import { endpointToolsToRegistry } from 'glirastes/server';
import { TaskController } from './tasks.controller.js';

const scan = scanNestJsControllers({ controllers: [TaskController] });
export const registry = endpointToolsToRegistry(scan.tools);

@Module({
  controllers: [TaskController],
  imports: [
    AiChatModule.forRoot({
      model: openai('gpt-4o-mini'),
      systemPrompt: ({ currentDate }) => `You are a task assistant. Today is ${currentDate}.`,
      authGuard: AuthGuard('jwt'),
    }),
  ],
})
export class AppModule {}
