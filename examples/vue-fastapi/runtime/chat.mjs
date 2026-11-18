import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createGeneratedRuntimeSource, DEFAULT_LOCAL_LIMITS, materializeManifestToolRegistry } from 'glirastes/runtime';
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

/**
 * The runtime's own texts in Polish, a language Glirastes has no built-in
 * texts for. Deliberately partial: every other key falls back to English.
 */
export const RUNTIME_LOCALES = {
  pl: {
    closing: 'Musiałem tu przerwać: {reason}. Odpowiedź powyżej może być niepełna.',
    closingWithoutAnswer: 'Nie mogłem dokończyć tego zapytania: {reason}.',
    silentTurn: 'Nie udało mi się odpowiedzieć. Wyślij proszę zapytanie jeszcze raz, najlepiej dokładniej.',
  },
};

/** The UI language the web app sends with every chat request (`?lang=` of the page). */
export function requestLanguage(request) {
  return request.headers.get('x-app-language') ?? undefined;
}

/**
 * Turn limits by profile. `fixture` (the default) keeps the small limits the
 * scripted CI test runs with. `acceptance` gives a real model room for the
 * second acceptance run (docs/acceptance/second-app-vue-fastapi.md);
 * `sdk-default` is exactly what an app gets without setting any limit.
 */
export const LIMIT_PROFILES = {
  fixture: { localLimits: LOCAL_LIMITS, maxSteps: 3, maxOutputTokens: 200 },
  acceptance: {
    localLimits: {
      ...LOCAL_LIMITS, maxModelSteps: 10, maxToolCalls: 20, totalTimeoutMs: 180_000, toolTimeoutMs: 15_000,
      maxInputTokens: 120_000, maxOutputTokens: 16_000, maxEstimatedCostUsd: 2,
    },
    maxSteps: 10,
    maxOutputTokens: 2_000,
  },
  'sdk-default': { localLimits: DEFAULT_LOCAL_LIMITS },
};

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
 * Python never runs Glirastes; this Node process does. `limits` names a
 * profile of LIMIT_PROFILES; `locale` sets the default language of the texts
 * the handler writes itself (the budget stop notice), e.g. `de-DE`; a request
 * that names its language (`x-app-language`) gets that one.
 */
export function createChatRuntime({ apiOrigin, model, tenantId, limits = 'fixture', locale }) {
  const profile = LIMIT_PROFILES[limits];
  if (!profile) throw new Error(`Unknown limit profile ${limits}; use ${Object.keys(LIMIT_PROFILES).join(', ')}`);
  const glirastes = createGeneratedRuntimeSource(generated, {
    localLimits: profile.localLimits,
    identity: { tenantId },
  });
  const handle = createAiChatHandler({
    managedRuntime: {
      resolvePrincipal: (request) => principalFor(request, apiOrigin()),
      resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context),
    },
    loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
    // Tool labels per language (tools.json languages) and the turn's language from the request.
    ...(generated.toolTexts ? { toolTexts: generated.toolTexts } : {}),
    requestLocale: requestLanguage,
    locales: RUNTIME_LOCALES,
    endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: apiOrigin(), request }),
    model: () => model(),
    systemPrompt: 'Use only the available tools; ask when the target is unclear.',
    ...(profile.maxSteps !== undefined ? { maxSteps: profile.maxSteps } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    ...(locale ? { locale } : {}),
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
