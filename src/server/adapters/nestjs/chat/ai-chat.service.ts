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
  type streamText,
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
import { protectedStreamText } from '../../../pii-shield/model-calls.js';
import { toSafeError } from '../../../pii-shield/detection-result.js';

/** Error class without message or stack: both can carry prompt or tool content. */
export function errorName(error: unknown): string {
  return error instanceof Error ? toSafeError(error).name : typeof error;
}

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
    // The protected-text profile exists only in the Next.js handler. Refuse a
    // privacy configuration here instead of running unprotected.
    if ('privacy' in options || 'piiShield' in options) {
      throw new ServiceUnavailableException('privacy_profile_unsupported');
    }

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
        // Error messages can carry tool arguments or backend data: log the
        // error class only.
        this.logger.error(`Tool "${toolId}" execution error: ${errorName(error)}`);
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
        // Outside the protected-text profile: privacy is refused above.
        const result = protectedStreamText({
          model: options.model,
          system: systemPrompt,
          messages: modelMessages as NonNullable<
            Parameters<typeof streamText>[0]['messages']
          >,
          tools: vercelTools as Parameters<typeof streamText>[0]['tools'],
          stopWhen: stepCountIs(maxSteps),
          // The AI SDK default logs the whole provider error with console.error,
          // including the request body. Log name and code only.
          onError: ({ error }: { error: unknown }) => {
            const safe = toSafeError(error);
            this.logger.error(`Model stream error: ${safe.name} (${safe.code})`);
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStepFinish: (step: any) => {
            // Counts only: tool arguments and results are business data.
            this.logger.debug(
              `Step finished: toolCalls=${step.toolCalls?.length ?? 0}, toolResults=${step.toolResults?.length ?? 0}, finishReason=${step.finishReason}`,
            );
          },
        }, null);

        writer.merge(result.toUIMessageStream());

        try {
          await result.response;
        } catch (error) {
          this.logger.error(`Stream error: ${errorName(error)}`);
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
