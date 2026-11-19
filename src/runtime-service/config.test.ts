import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, requestLocaleOf } from "./config.js";
import { credentialHeaders, resolveBackendPrincipal } from "./identity.js";
const raw = () => ({
  schemaVersion: 1,
  server: { publicOrigin: "https://app.test" },
  application: {
    artifact: "/artifact",
    apiOrigin: "http://backend:8080",
    allowedPathPrefixes: ["/api"],
  },
  identity: {
    endpoint: "/api/me",
    credential: { type: "cookie", names: ["session"] },
  },
  model: { name: "test", apiKeyFile: "/secrets/model" },
  approvals: {
    secretFile: "/secrets/approval",
    connectionStringFile: "/secrets/db",
  },
});
describe("runtime service trust configuration", () => {
  it("accepts an explicit fixed backend and defaults standalone", () => {
    expect(parseRuntimeConfig(raw()).platform.enabled).toBe(false);
  });
  it.each([
    "https://user:pass@backend",
    "http://backend/api",
    "file:///etc/passwd",
  ])("rejects non-origin backend %s", (apiOrigin) => {
    const c = raw();
    c.application.apiOrigin = apiOrigin;
    expect(() => parseRuntimeConfig(c)).toThrow();
  });
  it("accepts maxResultChars from 1000 to 200000 and leaves it unset by default", () => {
    expect(parseRuntimeConfig(raw()).application.maxResultChars).toBeUndefined();
    for (const value of [1_000, 40_000, 200_000]) {
      const c = { ...raw(), application: { ...raw().application, maxResultChars: value } };
      expect(parseRuntimeConfig(c).application.maxResultChars).toBe(value);
    }
    for (const value of [999, 200_001, 5_000.5, "40000"]) {
      const c = { ...raw(), application: { ...raw().application, maxResultChars: value } };
      expect(() => parseRuntimeConfig(c)).toThrow();
    }
  });
  it("accepts resultHandles as a boolean and leaves it unset by default", () => {
    expect(parseRuntimeConfig(raw()).application.resultHandles).toBeUndefined();
    for (const value of [true, false]) {
      const c = { ...raw(), application: { ...raw().application, resultHandles: value } };
      expect(parseRuntimeConfig(c).application.resultHandles).toBe(value);
    }
    for (const value of ["false", 0, { maxResults: 2 }]) {
      const c = { ...raw(), application: { ...raw().application, resultHandles: value } };
      expect(() => parseRuntimeConfig(c)).toThrow();
    }
  });
  it("accepts limits.approvalLookups strictly (or false) and leaves it unset by default", () => {
    expect(parseRuntimeConfig(raw()).limits.approvalLookups).toBeUndefined();
    const withLookups = (value: unknown) => ({ ...raw(), limits: { approvalLookups: value } });
    expect(parseRuntimeConfig(withLookups(false)).limits.approvalLookups).toBe(false);
    expect(parseRuntimeConfig(withLookups({ maxLookupsPerTurn: 10, lookupTimeoutMs: 500 })).limits.approvalLookups)
      .toEqual({ maxLookupsPerTurn: 10, lookupTimeoutMs: 500 });
    // The signed budget's own limit keeps its default and meaning.
    expect(parseRuntimeConfig(withLookups({ maxLookupsPerTurn: 10 })).limits.maxToolCalls).toBe(8);
    for (const value of [true, { maxLookupsPerTurn: 0 }, { maxLookupsPerTurn: 1.5 }, { other: 1 }]) {
      expect(() => parseRuntimeConfig(withLookups(value))).toThrow();
    }
  });
  it("accepts the chat languages and leaves them unset by default", () => {
    expect(parseRuntimeConfig(raw()).chat).toBeUndefined();
    const chat = { locale: "de-DE", requestLocaleHeader: "accept-language", locales: { pl: { silentTurn: "Nie udało się." } } };
    expect(parseRuntimeConfig({ ...raw(), chat }).chat).toEqual(chat);
    for (const wrong of [{ locale: "de_DE" }, { requestLocaleHeader: "X-App Language" }, { locales: { de_DE: {} } }, { theme: "dark" }]) {
      expect(() => parseRuntimeConfig({ ...raw(), chat: wrong })).toThrow();
    }
  });
  it("reads the turn language from the configured header", () => {
    const request = (headers: Record<string, string>) => new Request("https://app.test/glirastes/chat", { headers });
    expect(requestLocaleOf(request({ "accept-language": "pl-PL,pl;q=0.9,en;q=0.8" }), "accept-language")).toBe("pl-PL");
    expect(requestLocaleOf(request({ "x-app-language": "de" }), "x-app-language")).toBe("de");
    expect(requestLocaleOf(request({ "x-app-language": "<script>" }), "x-app-language")).toBeUndefined();
    expect(requestLocaleOf(request({}), "x-app-language")).toBeUndefined();
  });
  it("rejects unsafe identity targets and unknown settings", () => {
    const c = raw();
    c.identity.endpoint = "//evil/me";
    expect(() => parseRuntimeConfig(c)).toThrow();
    expect(() => parseRuntimeConfig({ ...raw(), sidecar: true })).toThrow();
  });
  it("requires managed environment and key", () => {
    expect(() =>
      parseRuntimeConfig({ ...raw(), platform: { enabled: true } }),
    ).toThrow();
  });
  it("selects only configured cookies, never caller roles or authorization", () => {
    const c = parseRuntimeConfig(raw());
    const h = credentialHeaders(
      new Request("https://app.test", {
        headers: {
          cookie: "other=secret; session=valid",
          authorization: "Bearer admin",
          "x-role": "admin",
        },
      }),
      c,
    );
    expect([...h]).toEqual([["cookie", "session=valid"]]);
  });
  it("separates business tenant subjects within the runtime tenant", async () => {
    const c = parseRuntimeConfig(raw());
    const request = new Request("https://app.test", {
      headers: { cookie: "session=valid" },
    });
    const fetcher = async () =>
      Response.json({
        userId: "42",
        tenantId: "business-a",
        roles: ["reader"],
      });
    const p = await resolveBackendPrincipal(
      request,
      "platform-tenant",
      c,
      fetcher as typeof fetch,
    );
    expect(p?.tenantId).toBe("platform-tenant");
    expect(p?.subjectId).toBe(
      createHash("sha256")
        .update(JSON.stringify(["business-a", "42"]))
        .digest("hex"),
    );
    expect(p?.roles).toEqual(["reader"]);
  });
  it("fails closed on absent credentials or invalid backend identity", async () => {
    const c = parseRuntimeConfig(raw());
    expect(
      await resolveBackendPrincipal(
        new Request("https://app.test"),
        "tenant",
        c,
      ),
    ).toBeUndefined();
    expect(
      await resolveBackendPrincipal(
        new Request("https://app.test", { headers: { cookie: "session=x" } }),
        "tenant",
        c,
        (async () =>
          Response.json({
            userId: "u",
            tenantId: "t",
            roles: ["admin"],
            token: "secret",
          })) as typeof fetch,
      ),
    ).toBeUndefined();
  });
});
