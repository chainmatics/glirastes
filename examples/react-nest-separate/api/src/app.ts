import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { ChatOptions } from './chat/chat.options.js';

/** The API with every route under `/api`; the generator reads the same prefix. */
export async function createApi(options: ChatOptions) {
  const app = await NestFactory.create(AppModule.with(options), new ExpressAdapter(), { logger: false });
  app.setGlobalPrefix('api');
  return app;
}
