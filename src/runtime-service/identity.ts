import { createHash } from "node:crypto";
import { z } from "zod";
import type { Principal } from "../contracts/index.js";
import type { RuntimeServiceConfig } from "./config.js";

const identitySchema = z
  .object({
    userId: z.string().min(1).max(256),
    tenantId: z.string().min(1).max(256),
    roles: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();

/** Only credentials explicitly selected by the operator cross the API boundary. */
export function credentialHeaders(
  request: Request,
  config: RuntimeServiceConfig,
): Headers {
  const headers = new Headers();
  const c = config.identity.credential;
  if (c.type === "bearer") {
    const value = request.headers.get("authorization");
    if (value && /^Bearer [^\s]+$/i.test(value) && value.length <= 8192)
      headers.set("authorization", value);
  } else {
    const values = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const split = part.indexOf("=");
      if (split < 1) continue;
      const name = part.slice(0, split).trim();
      if (!c.names.includes(name)) continue;
      if (values.has(name)) duplicates.add(name);
      values.set(name, part.slice(split + 1).trim());
    }
    if (duplicates.size) return headers;
    const cookie = [...values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie && cookie.length <= 8192) headers.set("cookie", cookie);
  }
  if (config.identity.csrfHeader) {
    const value = request.headers.get(config.identity.csrfHeader);
    if (value && value.length <= 8192)
      headers.set(config.identity.csrfHeader, value);
  }
  return headers;
}

export async function resolveBackendPrincipal(
  request: Request,
  runtimeTenantId: string,
  config: RuntimeServiceConfig,
  fetcher: typeof fetch = fetch,
): Promise<Principal | undefined> {
  const headers = credentialHeaders(request, config);
  if (!headers.has("cookie") && !headers.has("authorization")) return undefined;
  try {
    const response = await fetcher(
      new URL(config.identity.endpoint, config.application.apiOrigin),
      {
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(Math.min(config.application.timeoutMs, 5000)),
        ]),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32768) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = identitySchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (!parsed.success) return undefined;
    return {
      tenantId: runtimeTenantId,
      subjectId: createHash("sha256")
        .update(JSON.stringify([parsed.data.tenantId, parsed.data.userId]))
        .digest("hex"),
      roles: parsed.data.roles,
      attributes: {
        businessTenantId: parsed.data.tenantId,
        userId: parsed.data.userId,
      },
    };
  } catch {
    return undefined;
  }
}
