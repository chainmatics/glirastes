import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import { createHttpEndpointCaller } from 'glirastes/server';
import { createAiChatHandler } from 'glirastes/server/nextjs';
import * as generated from '../generated/glirastes/tools.generated.js';
import { resolveSession } from '../auth/sessions.js';
import { CHAT_OPTIONS, type ChatOptions } from './chat.options.js';

interface IncomingChat {
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const LOCAL_LIMITS = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

/** The chat endpoint: the framework-neutral handler, its tools calling this API with the user's credentials. */
@Controller('chat')
export class ChatController {
  private readonly handle: (request: Request) => Promise<Response>;

  constructor(@Inject(CHAT_OPTIONS) options: ChatOptions) {
    const glirastes = createGeneratedRuntimeSource(generated, {
      localLimits: LOCAL_LIMITS,
      identity: { tenantId: options.tenantId },
    });
    this.handle = createAiChatHandler({
      managedRuntime: {
        resolvePrincipal: resolveSession,
        resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context),
      },
      loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot!, bindings: glirastes.bindings }),
      endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: options.apiOrigin(), request }),
      model: () => options.model(),
      systemPrompt: 'Use only the available tools; ask when the target is unclear.',
      maxSteps: 3,
      maxOutputTokens: 200,
    });
  }

  @Post()
  async chat(@Req() incoming: IncomingChat, @Res() outgoing: ServerResponse): Promise<void> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const response = await this.handle(new Request(new URL(incoming.originalUrl, 'http://api.local'), {
      method: 'POST',
      headers,
      body: JSON.stringify(incoming.body ?? {}),
    }));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => { outgoing.setHeader(name, value); });
    if (!response.body) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body as NodeReadableStream).pipe(outgoing);
  }
}
