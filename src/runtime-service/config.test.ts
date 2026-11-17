import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "./config.js";
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
