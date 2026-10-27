import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import { createHttpEndpointCaller } from 'glirastes/server';
import { createAiChatHandler } from 'glirastes/server/nextjs';
import * as generated from '../.glirastes/build/tools.generated.mjs';

const LOCAL_LIMITS = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};
const CREDENTIALS = ['cookie', 'authorization'];

/** The user of a chat request: the FastAPI app answers /api/me for the forwarded session. */
async function principalFor(request, apiOrigin) {
  const headers = new Headers();
  for (const name of CREDENTIALS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await fetch(new URL('/api/me', apiOrigin), { headers });
  return response.ok ? response.json() : undefined;
}

/**
 * The chat runtime next to the FastAPI app: the framework-neutral handler,
 * its endpoint tools calling the API with the user's own credentials.
 * Python never runs Glirastes; this Node process does.
 */
export function createChatRuntime({ apiOrigin, model, tenantId }) {
  const glirastes = createGeneratedRuntimeSource(generated, {
    localLimits: LOCAL_LIMITS,
    identity: { tenantId },
  });
  const handle = createAiChatHandler({
    managedRuntime: {
      resolvePrincipal: (request) => principalFor(request, apiOrigin()),
      resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context),
    },
    loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
    endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: apiOrigin(), request }),
    model: () => model(),
    systemPrompt: 'Use only the available tools; ask when the target is unclear.',
    maxSteps: 3,
    maxOutputTokens: 200,
  });
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://runtime.local');
    if (incoming.method !== 'POST' || url.pathname !== '/api/chat') {
      outgoing.statusCode = 404;
      outgoing.end();
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const response = await handle(new Request(url, { method: 'POST', headers, body: Buffer.concat(chunks) }));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => { outgoing.setHeader(name, value); });
    if (!response.body) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(outgoing);
  });
  return { disabled: glirastes.disabled, server };
}
