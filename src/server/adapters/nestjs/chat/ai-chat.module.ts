import type { IncomingMessage } from 'http';
import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { AiToolsExplorerService } from '../module/ai-tools-explorer.service.js';
import { AiToolsService } from '../module/ai-tools.service.js';
import { createAiToolsProviders } from '../module/ai-tools.module.js';
import type { INestApplication } from '@nestjs/common';
import { WebSocketServer } from 'ws';
import { AiChatController } from './ai-chat.controller.js';
import { AiChatService } from './ai-chat.service.js';
import {
  AI_CHAT_MODULE_OPTIONS,
  type AiChatModuleAsyncOptions,
  type AiChatModuleOptions,
} from './ai-chat-module-options.interface.js';
import { createSpeechStreamHandler } from './speech-stream.gateway.js';
import { AiChatAuthGuard } from './ai-chat-auth.guard.js';

@Module({})
export class AiChatModule {
  private static initialized = false;

  static forRoot(options: AiChatModuleOptions): DynamicModule {
    AiChatModule.initialized = true;

    const aiProviders = createAiToolsProviders();

    return {
      module: AiChatModule,
      imports: [DiscoveryModule],
      controllers: [AiChatController],
      providers: [
        {
          provide: AI_CHAT_MODULE_OPTIONS,
          useValue: options,
        },
        {
          provide: AiToolsExplorerService,
          useFactory: (
            discoveryService: DiscoveryService,
            reflector: Reflector,
          ) => aiProviders.createExplorer(discoveryService, reflector),
          inject: [DiscoveryService, Reflector],
        },
        {
          provide: AiToolsService,
          useFactory: (explorer: AiToolsExplorerService) =>
            aiProviders.createService(explorer),
          inject: [AiToolsExplorerService],
        },
        AiChatAuthGuard,
        AiChatService,
      ],
      exports: [AiToolsService],
    };
  }

  static forRootAsync(asyncOptions: AiChatModuleAsyncOptions): DynamicModule {
    AiChatModule.initialized = true;

    return {
      module: AiChatModule,
      imports: [DiscoveryModule, ...(asyncOptions.imports ?? [])],
      controllers: [AiChatController],
      providers: [
        {
          provide: AI_CHAT_MODULE_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: asyncOptions.inject ?? [],
        },
        {
          provide: AiToolsExplorerService,
          useFactory: (
            _options: AiChatModuleOptions | null,
            discoveryService: DiscoveryService,
            reflector: Reflector,
          ) => {
            const aiProviders = createAiToolsProviders();
            return aiProviders.createExplorer(discoveryService, reflector);
          },
          inject: [AI_CHAT_MODULE_OPTIONS, DiscoveryService, Reflector],
        },
        {
          provide: AiToolsService,
          useFactory: (explorer: AiToolsExplorerService) =>
            new AiToolsService(explorer),
          inject: [AiToolsExplorerService],
        },
        AiChatAuthGuard,
        AiChatService,
      ],
      exports: [AiToolsService],
    };
  }

  static attachWebSockets(app: INestApplication): void {
    if (!AiChatModule.initialized) {
      throw new Error(
        'AiChatModule.forRoot() or forRootAsync() must be called before attachWebSockets()',
      );
    }

    const options = app.get<AiChatModuleOptions | null>(
      AI_CHAT_MODULE_OPTIONS,
    );

    if (!options?.features?.speechToText) {
      return;
    }

    const logger = new Logger('AiChatModule');
    const configService = app.get(ConfigService);
    const deepgramKey = configService.get<string>('DEEPGRAM_API_KEY');

    if (!deepgramKey) {
      throw new Error(
        'DEEPGRAM_API_KEY environment variable is required when speechToText feature is enabled',
      );
    }

    const httpServer = app.getHttpServer();
    const wss = new WebSocketServer({ noServer: true });
    const handleSpeechStream = createSpeechStreamHandler(configService);

    httpServer.on('upgrade', (req: IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
      if (req.url?.startsWith('/api/ai/speech-stream')) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleSpeechStream(ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    logger.log('Speech-to-text WebSocket attached at /api/ai/speech-stream');
  }
}
