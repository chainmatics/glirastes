import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../contracts/index.js";
import type { AiChatHandlerFullConfig } from "../server/adapters/nextjs/create-ai-chat-handler.js";
import type { RuntimeHttpOptions } from "./server.js";
import { parseRuntimeConfig } from "./config.js";

const state = vi.hoisted(() => ({
  host: undefined as RuntimeHttpOptions | undefined,
  handler: undefined as AiChatHandlerFullConfig | undefined,
  leaseHealthy: true,
  accepted: true,
  lose: undefined as (() => void) | undefined,
  abortAll: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
}));
vi.mock("pg", () => {
  class Pool {
    on() {}
    async end() {
      state.end();
    }
  }
  // The service uses the default export (pg below 8.15.0 has no named ESM exports).
  return { default: { Pool } };
});
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ chat: () => ({}) }),
}));
vi.mock("./artifact.js", () => ({
  loadRuntimeArtifact: async () => ({
    setupArtifact: {
      schemaVersion: 1,
      artifactId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      appId: "00000000-0000-4000-8000-000000000003",
      discoveryDigest: "sha256:" + "a".repeat(43),
      assessmentMode: "autonomous",
      status: "ready",
      tools: [],
      planner: {
        plannerId: "00000000-0000-4000-8000-000000000004",
        modelBindingRef: "default",
        promptBindingRef: "local",
        budgetProfileRef: "default",
        toolIds: [],
      },
      prompts: {
        bundleDigest: "sha256:" + "b".repeat(43),
        artifactRef: "local://prompts",
        plannerDigest: "sha256:" + "c".repeat(43),
        appBehaviorDigest: "sha256:" + "d".repeat(43),
        responseStyleDigest: "sha256:" + "e".repeat(43),
        capabilityFragmentDigests: {},
      },
      warnings: [],
      generatedAt: "2026-11-15T00:00:00Z",
    },
    promptBundle: {
      sections: {
        planner: "Help",
        appBehavior: "Help",
        responseStyle: "Concise",
        capabilityFragments: {},
      },
    },
  }),
}));
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  readSecret: async () => "a".repeat(40),
}));
vi.mock("./approval-store.js", () => ({
  createPostgresApprovalStore: () => ({
    initialize: async () => {},
    healthy: async () => true,
    consume: async () => true,
  }),
  acquireRuntimeLease: async (
    _pool: unknown,
    _namespace: string,
    onLost: () => void,
  ) => {
    state.lose = () => {
      state.leaseHealthy = false;
      onLost();
    };
    return {
      healthy: () => state.leaseHealthy,
      check: async () => state.leaseHealthy,
      release: async () => {
        state.release();
      },
    };
  },
}));
vi.mock("../runtime/glirastes.js", () => ({
  createGlirastes: () => ({
    accepted: () => (state.accepted ? {} : undefined),
    ready: async () => {},
    stop: async () => {
      state.stop();
    },
    chatTurn: async (
      resolve: (
        tenant: string,
        request: Request,
      ) => Promise<Principal | undefined>,
    ) => ({
      managedRuntime: {
        resolvePrincipal: (request: Request) =>
          resolve("platform-tenant", request),
      },
    }),
  }),
}));
vi.mock("../server/adapters/nextjs/create-ai-chat-handler.js", () => ({
  createAiChatHandler: (config: AiChatHandlerFullConfig) => {
    state.handler = config;
    return async () => new Response("ok");
  },
}));
vi.mock("./server.js", () => ({
  createRuntimeHttpServer: (options: RuntimeHttpOptions) => {
    state.host = options;
    return {
      abortAll: state.abortAll,
      close: async () => {
        state.close();
      },
      server: {
        once() {},
        off() {},
        listen(_port: number, _host: string, resolve: () => void) {
          resolve();
        },
      },
    };
  },
}));
import { startRuntimeService } from "./service.js";

const config = () =>
  parseRuntimeConfig({
    schemaVersion: 1,
    server: { publicOrigin: "https://app.test" },
    application: {
      artifact: "/artifact",
      apiOrigin: "http://backend:8080",
      allowedPathPrefixes: ["/api"],
    },
    identity: {
      endpoint: "/api/identity",
      credential: { type: "cookie", names: ["session"] },
    },
    model: { name: "test", apiKeyFile: "/model" },
    approvals: { secretFile: "/approval", connectionStringFile: "/db" },
  });
const request = () =>
  new Request("https://app.test/glirastes/chat", {
    method: "POST",
    headers: {
      cookie: "session=user; other=PRIVATE",
      authorization: "Bearer ADMIN",
      "x-tenant": "evil",
      "x-role": "admin",
    },
    body: "{}",
  });
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  state.leaseHealthy = true;
  state.accepted = true;
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  vi.unstubAllGlobals();
});
async function started() {
  const service = await startRuntimeService(config());
  cleanups.push(service.stop);
  await state.host!.handleChat(request());
  return service;
}

describe("runtime service security wiring", () => {
  it("binds approval signing secrets to application and environment even when master keys are reused", async () => {
    const one = await started();
    const first = state.handler!.approvalSecret;
    expect(first).toBe(
      createHmac("sha256", "a".repeat(40))
        .update(
          JSON.stringify([
            "glirastes-runtime-approval-v1",
            "00000000-0000-4000-8000-000000000003",
            "standalone",
          ]),
        )
        .digest("hex"),
    );
    await one.stop();
    const c = config();
    c.platform = {
      enabled: true,
      environment: "production",
      apiKeyFile: "/key",
      requireAcceptedDeployment: true,
    };
    const two = await startRuntimeService(c);
    cleanups.push(two.stop);
    await state.host!.handleChat(request());
    expect(state.handler!.approvalSecret).not.toBe(first);
  });

  it("pins the verified business tenant and user for one turn", async () => {
    let tenantId = "one";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ userId: "u", tenantId, roles: ["reader"] }),
      ),
    );
    await started();
    const resolve = state.handler!.managedRuntime!.resolvePrincipal;
    const first = await resolve(request());
    expect(first).toMatchObject({
      tenantId: "platform-tenant",
      attributes: { businessTenantId: "one", userId: "u" },
    });
    tenantId = "two";
    expect(await resolve(request())).toBeUndefined();
  });

  it("uses refreshed roles and never copies client roles", async () => {
    let roles = ["writer"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ userId: "u", tenantId: "one", roles })),
    );
    await started();
    const resolve = state.handler!.managedRuntime!.resolvePrincipal;
    expect(await resolve(request())).toMatchObject({ roles: ["writer"] });
    roles = ["reader"];
    expect(await resolve(request())).toMatchObject({ roles: ["reader"] });
  });

  it("only sends selected user credentials to the fixed backend", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    await started();
    await state.handler!.endpointCaller!(request())({
      method: "GET",
      path: "/api/tasks",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://backend:8080/api/tasks");
    expect(init?.headers).toEqual({ cookie: "session=user" });
    expect(init?.redirect).toBe("error");
  });

  it("aborts active work and denies authorization after losing its singleton lease", async () => {
    const service = await started();
    state.lose!();
    expect(state.abortAll).toHaveBeenCalledOnce();
    expect(await service.ready()).toBe(false);
    expect(
      await state.handler!.managedRuntime!.resolvePrincipal(request()),
    ).toBeUndefined();
  });

  it("refuses a managed deployment before a signed accepted revision exists", async () => {
    const c = config();
    c.platform = {
      enabled: true,
      apiKeyFile: "/platform",
      environment: "production",
      requireAcceptedDeployment: true,
    };
    state.accepted = false;
    const service = await startRuntimeService(c);
    cleanups.push(service.stop);
    expect(await service.ready()).toBe(false);
    await state.host!.handleChat(request());
    expect(
      await state.handler!.managedRuntime!.resolvePrincipal(request()),
    ).toBeUndefined();
  });
});

describe("runtime context and cleanup", () => {
  it("pins backend user and business-tenant headers from verified identity, never from caller headers", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/api/identity")
        ? Response.json({ userId: "u", tenantId: "one", roles: ["writer"] })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    await started();
    await state.handler!.managedRuntime!.resolvePrincipal(request());
    await state.handler!.endpointCaller!(request())({
      method: "POST",
      path: "/api/tasks",
      body: { title: "new" },
    });
    const [, init] = fetcher.mock.calls.at(-1)!;
    expect(init?.headers).toMatchObject({
      "x-glirastes-business-tenant": "one",
      "x-glirastes-user-id": "u",
      cookie: "session=user",
    });
    expect(JSON.stringify(init?.headers)).not.toContain("ADMIN");
  });

  it("hands chat.uiActionOutcomes to the chat handler and leaves its default otherwise", async () => {
    await started();
    expect(state.handler!.uiActionOutcomes).toBeUndefined();
    const base = config();
    const service = await startRuntimeService({ ...base, chat: { uiActionOutcomes: "report-only" } });
    cleanups.push(service.stop);
    await state.host!.handleChat(request());
    expect(state.handler!.uiActionOutcomes).toBe("report-only");
  });

  it("hands chat.history to the chat handler and leaves the SDK's history defaults otherwise", async () => {
    await started();
    expect(state.handler!.history).toBeUndefined();
    const base = config();
    const service = await startRuntimeService({ ...base, chat: { history: { toolTurnCounting: "all-turns", seenObjects: false } } });
    cleanups.push(service.stop);
    await state.host!.handleChat(request());
    expect(state.handler!.history).toEqual({ toolTurnCounting: "all-turns", seenObjects: false });
  });

  it("hands chat.locales stream error texts to the chat handler, which streams them; an unknown key fails at start", async () => {
    const base = config();
    const locales = { pl: { streamError: "Żądanie nie powiodło się", invalidToolInput: "Nieprawidłowe dane" } };
    const service = await startRuntimeService({ ...base, chat: { locale: "pl-PL", locales } });
    cleanups.push(service.stop);
    await state.host!.handleChat(request());
    expect(state.handler!.locales).toEqual(locales);
    // The texts the service handed on reach the stream error output of the real handler.
    const { createAiChatHandler } = await vi.importActual<typeof import("../server/adapters/nextjs/create-ai-chat-handler.js")>(
      "../server/adapters/nextjs/create-ai-chat-handler.js",
    );
    const { MockLanguageModelV3 } = await import("ai/test");
    const handler = createAiChatHandler({
      tools: {}, systemPrompt: "A", onError: vi.fn(), locale: state.handler!.locale, locales: state.handler!.locales,
      model: new MockLanguageModelV3({ doStream: async () => { throw new Error("boom"); } }),
    });
    const body = await (await handler(new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] }] }),
    }))).text();
    expect(body).toContain("Żądanie nie powiodło się");
    expect(body).not.toContain("AI request failed");
    await expect(startRuntimeService({ ...base, chat: { locales: { pl: { bogus: "x" } } } } as never))
      .rejects.toThrow(/locales\.pl\.bogus is not a text key/);
  });

  it("emits no exception content in its handler error callback", async () => {
    await started();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const error = new Error("PRIVATE customer payload");
      error.name = "SECRET credential";
      state.handler!.onError!(error, request());
      const logs = JSON.stringify(output.mock.calls);
      expect(logs).toContain("chat_turn_error");
      expect(logs).not.toMatch(/PRIVATE|SECRET/);
    } finally {
      output.mockRestore();
    }
  });

  it("releases database resources even if runtime shutdown fails", async () => {
    const service = await started();
    state.stop.mockImplementationOnce(() => {
      throw new Error("shutdown failed");
    });
    await expect(service.stop()).rejects.toThrow("shutdown failed");
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.end).toHaveBeenCalledOnce();
  });
});
