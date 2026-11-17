import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { AppSetupArtifactSchema, type Principal } from "../contracts/index.js";
import { createOpenAI } from "@ai-sdk/openai";
import { createGlirastes } from "../runtime/glirastes.js";
import { createAiChatHandler } from "../server/adapters/nextjs/create-ai-chat-handler.js";
import { createHttpEndpointCaller } from "../server/core/index.js";
import { loadRuntimeArtifact } from "./artifact.js";
import {
  acquireRuntimeLease,
  createPostgresApprovalStore,
} from "./approval-store.js";
import { credentialHeaders, resolveBackendPrincipal } from "./identity.js";
import { readSecret, type RuntimeServiceConfig } from "./config.js";
import { createRuntimeHttpServer } from "./server.js";

/** No business content or credential is included in service diagnostics. */
function event(type: string) {
  process.stdout.write(JSON.stringify({ type }) + "\n");
}

export async function startRuntimeService(config: RuntimeServiceConfig) {
  const generated = await loadRuntimeArtifact(config.application.artifact);
  const [connectionString, approvalSecret, modelKey] = await Promise.all([
    readSecret(config.approvals.connectionStringFile),
    readSecret(config.approvals.secretFile),
    readSecret(config.model.apiKeyFile),
  ]);
  if (approvalSecret.length < 32)
    throw new Error("Approval secret must contain at least 32 characters");
  const pool = new Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    keepAlive: true,
  });
  pool.on("error", () => event("state_pool_error"));
  const runtimeScope = [
    AppSetupArtifactSchema.parse(generated.setupArtifact).appId,
    config.platform.enabled ? config.platform.environment : "standalone",
  ];
  const namespace = JSON.stringify(runtimeScope);
  const approvalSigningSecret = createHmac("sha256", approvalSecret)
    .update(JSON.stringify(["glirastes-runtime-approval-v1", ...runtimeScope]))
    .digest("hex");
  const store = createPostgresApprovalStore(pool, { namespace });
  let host: ReturnType<typeof createRuntimeHttpServer> | undefined;
  let lease: Awaited<ReturnType<typeof acquireRuntimeLease>> | undefined;
  let runtime: ReturnType<typeof createGlirastes> | undefined;
  let stopping = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (monitor) clearInterval(monitor);
    try {
      await host?.close();
    } finally {
      try {
        await runtime?.stop();
      } finally {
        try {
          await lease?.release();
        } finally {
          await pool.end();
        }
      }
    }
  };
  try {
    await store.initialize();
    lease = await acquireRuntimeLease(pool, namespace, () => {
      host?.abortAll();
      event("runtime_lease_lost");
    });
    const env: Record<string, string | undefined> = {};
    if (config.platform.enabled) {
      env.GLIRASTES_API_KEY = await readSecret(config.platform.apiKeyFile);
      env.GLIRASTES_ENVIRONMENT = config.platform.environment;
      env.GLIRASTES_CONTROL_PLANE_URL = config.platform.controlPlaneOrigin;
    }
    runtime = createGlirastes({
      generated,
      env,
      runtime: "container-v1",
      localLimits: {
        ...config.limits,
        toolTimeoutMs: config.application.timeoutMs,
      },
      onError: () => event("platform_sync_error"),
    });
    const glirastes = runtime;
    const model = createOpenAI({
      baseURL: config.model.baseUrl,
      apiKey: modelKey,
    }).chat(config.model.name);
    const ready = async () =>
      !stopping &&
      Boolean(await lease?.check()) &&
      (await store.healthy()) &&
      (!config.platform.enabled || Boolean(glirastes.accepted()));
    host = createRuntimeHttpServer({
      config,
      isReady: ready,
      onEvent: (e) => process.stdout.write(JSON.stringify(e) + "\n"),
      handleChat: async (request) => {
        // Resolve anew before every tool call. A session that switches user or
        // business tenant mid-turn must not inherit the original turn's approval.
        let pinnedPrincipal: Principal | undefined;
        const turn = await glirastes.chatTurn(async (tenantId, req) => {
          if (
            !lease?.healthy() ||
            (config.platform.enabled && !glirastes.accepted())
          )
            return undefined;
          const principal = await resolveBackendPrincipal(
            req,
            tenantId,
            config,
          );
          if (
            !principal ||
            (pinnedPrincipal !== undefined &&
              principal.subjectId !== pinnedPrincipal.subjectId)
          )
            return undefined;
          pinnedPrincipal ??= principal;
          return principal;
        });
        const handle = createAiChatHandler({
          ...turn,
          model,
          systemPrompt: [
            generated.promptBundle.sections.planner,
            generated.promptBundle.sections.appBehavior,
            generated.promptBundle.sections.responseStyle,
            ...Object.values(
              generated.promptBundle.sections.capabilityFragments,
            ),
          ].join("\n\n"),
          onError: () => event("chat_turn_error"),
          approvalSecret: approvalSigningSecret,
          approvalStore: store,
          toolDiscovery: true,
          maxBodyBytes: config.server.maxBodyBytes,
          maxSteps: config.limits.maxModelSteps,
          maxOutputTokens: config.limits.maxOutputTokens,
          ...(config.application.maxResultChars !== undefined
            ? { maxResultChars: config.application.maxResultChars }
            : {}),
          endpointCaller: (req) =>
            createHttpEndpointCaller({
              defaultHeaders: pinnedPrincipal
                ? {
                    "x-glirastes-business-tenant": String(
                      pinnedPrincipal.attributes.businessTenantId,
                    ),
                    "x-glirastes-user-id": String(
                      pinnedPrincipal.attributes.userId,
                    ),
                  }
                : {},
              baseUrl: config.application.apiOrigin,
              request: new Request(req.url, {
                headers: credentialHeaders(req, config),
                signal: req.signal,
              }),
              forwardHeaderNames: [
                "cookie",
                "authorization",
                ...(config.identity.csrfHeader
                  ? [config.identity.csrfHeader]
                  : []),
              ],
              allowedPathPrefixes: config.application.allowedPathPrefixes,
              redirect: "error",
              timeoutMs: config.application.timeoutMs,
              maxResponseBytes: config.application.maxResponseBytes,
            }),
        });
        return handle(request);
      },
    });
    const server = host.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.server.port, config.server.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    monitor = setInterval(() => {
      void lease?.check().catch(() => host?.abortAll());
    }, 5000);
    monitor.unref();
    void glirastes.ready();
    event("runtime_listening");
    return { server, stop, ready };
  } catch (error) {
    await stop();
    throw error;
  }
}
