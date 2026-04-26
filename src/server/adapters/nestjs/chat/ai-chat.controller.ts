import {
  Body,
  Controller,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AiChatService } from './ai-chat.service.js';
import { AiChatRequestDto } from './dto/index.js';
import {
  AI_CHAT_MODULE_OPTIONS,
  type AiChatModuleOptions,
} from './ai-chat-module-options.interface.js';
import { AiChatAuthGuard } from './ai-chat-auth.guard.js';

@ApiTags('ai')
@UseGuards(AiChatAuthGuard)
@Controller('ai')
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(
    @Inject(AI_CHAT_MODULE_OPTIONS)
    private readonly options: AiChatModuleOptions | null,
    private readonly aiChatService: AiChatService,
  ) {}

  @Post('chat')
  @ApiOperation({ summary: 'Stream AI chat response' })
  async chat(
    @Body() dto: AiChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.options) {
      throw new ServiceUnavailableException('AI chat is not configured');
    }
    const authHeader = req.headers.authorization ?? '';

    this.logger.debug(`Chat request: ${dto.messages.length} messages`);

    let streamResponse: globalThis.Response;
    try {
      streamResponse = await this.aiChatService.streamChat(
        dto.messages as never,
        authHeader,
      );
    } catch (error) {
      this.logger.error(`streamChat() threw: ${error}`, (error as Error).stack);
      throw error;
    }

    this.logger.debug(`Stream response status: ${streamResponse.status}`);

    res.status(streamResponse.status);
    streamResponse.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    if (streamResponse.body) {
      const reader = streamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    this.logger.debug('Stream completed');
    res.end();
  }
}
