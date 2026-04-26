import type { z } from 'zod';
import type { WithAiToolOptions, AiToolRouteHandler } from './types.js';

/**
 * Wraps a Next.js App Router handler with AI tool metadata.
 * The handler works as before -- metadata is for the codegen scanner.
 */
export function withAiTool<TInput extends z.ZodTypeAny>(
  options: WithAiToolOptions<TInput>,
  handler: (
    req: Request,
    context?: { params: Promise<Record<string, string>> },
  ) => Response | Promise<Response>,
): AiToolRouteHandler {
  const decoratedHandler: AiToolRouteHandler = (req, ctx) =>
    handler(req, ctx);
  decoratedHandler.__aiToolMeta = options as WithAiToolOptions;
  return decoratedHandler;
}
