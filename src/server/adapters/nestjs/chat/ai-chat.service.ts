import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiToolsService } from '../module/ai-tools.service.js';
import {
  createFetchInternalApiCaller,
  toolsToAiTools,
} from '../../../core/index.js';
import type { ToolContext, PromptOverride } from '../../../../types.js';
import { applyPromptOverride } from '../../../../types.js';
import { ConfigService } from '@nestjs/config';
import {
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import type { ChatMessageDto } from './dto/index.js';
import {
  AI_CHAT_MODULE_OPTIONS,
  type AiChatModuleOptions,
} from './ai-chat-module-options.interface.js';

function wrapToolsForVercelAi(
  sdkTools: Record<string, unknown>,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(sdkTools)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = raw as any;
    wrapped[name] = tool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: zodSchema(t.parameters as any),
      needsApproval: t.needsApproval,
      execute: t.execute,
    });
  }
  return wrapped;
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @Inject(AI_CHAT_MODULE_OPTIONS)
    private readonly options: AiChatModuleOptions | null,
    private readonly aiToolsService: AiToolsService,
    private readonly configService: ConfigService,
  ) {}

  async streamChat(
    messages: ChatMessageDto[],
    authHeader: string,
  ): Promise<Response> {
    if (!this.options) {
      throw new ServiceUnavailableException('AI chat is not configured');
    }
    const options = this.options;

    const toolContext: ToolContext & {
      callEndpoint: ReturnType<typeof createFetchInternalApiCaller>;
    } = {
      currentDate: new Date(),
      locale: 'en-US',
      callEndpoint: createFetchInternalApiCaller({
        baseUrl: this.getInternalApiUrl(),
        defaultHeaders: { Authorization: authHeader },
      }),
    };

    const registry = this.aiToolsService.buildToolRegistry();
    const sdkTools = await toolsToAiTools(registry, toolContext, {
      onError: (toolId, error) => {
        this.logger.error(
          `Tool "${toolId}" execution error: ${error}`,
          error instanceof Error ? error.stack : undefined,
        );
      },
      onAudit: options.onAudit,
      sessionId: `nestjs-${Date.now()}`,
    });
    const vercelTools = wrapToolsForVercelAi(sdkTools);

    this.logger.log(
      `Chat request, ${Object.keys(vercelTools).length} tools available`,
    );
    this.logger.debug(`Available tools: ${Object.keys(vercelTools).join(', ')}`);

    const currentDate = new Date().toISOString().split('T')[0];
    let systemPrompt =
      typeof options.systemPrompt === 'function'
        ? options.systemPrompt({ currentDate })
        : options.systemPrompt;

    // Apply runtime prompt overrides from Glirastes (Pro feature)
    if (options.lancer) {
      try {
        const configResult = await options.lancer.config.fetch(['prompts']);
        const prompts = (configResult as { prompts?: PromptOverride[] }).prompts;
        // Apply first matching override (NestJS adapter doesn't classify intents yet,
        // so apply if there's a single module override as a reasonable default)
        if (prompts && prompts.length === 1) {
          systemPrompt = applyPromptOverride(systemPrompt, prompts[0]);
        }
      } catch {
        // Graceful degradation: use local prompt
      }
    }

    const modelMessages = await convertToModelMessages(messages as never);

    this.logger.debug(
      `Model messages: ${JSON.stringify(modelMessages.map((m) => ({ role: (m as Record<string, unknown>).role, contentLength: JSON.stringify((m as Record<string, unknown>).content).length })))}`,
    );

    const maxSteps = options.maxSteps ?? 4;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: options.model,
          system: systemPrompt,
          messages: modelMessages as NonNullable<
            Parameters<typeof streamText>[0]['messages']
          >,
          tools: vercelTools as Parameters<typeof streamText>[0]['tools'],
          stopWhen: stepCountIs(maxSteps),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStepFinish: (step: any) => {
            this.logger.debug(
              `Step finished: toolCalls=${JSON.stringify(step.toolCalls)}, toolResults=${JSON.stringify(step.toolResults)}, finishReason=${step.finishReason}`,
            );
          },
        });

        writer.merge(result.toUIMessageStream());

        try {
          await result.response;
        } catch (error) {
          this.logger.error(
            `Stream error: ${error}`,
            error instanceof Error ? error.stack : undefined,
          );
          throw error;
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  private getInternalApiUrl(): string {
    const port = this.configService.get<number>('PORT', 3001);
    return `http://localhost:${port}/api`;
  }
}
