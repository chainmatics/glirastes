import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  MAX_MAX_RESULT_CHARS,
  MIN_MAX_RESULT_CHARS,
} from "../runtime/result-limit.js";

const origin = z.string().refine((value) => {
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}, "Expected a fixed HTTP(S) origin without path or credentials");
const path = z.string().regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/);
const file = z
  .string()
  .refine(isAbsolute, "Secret and artifact paths must be absolute");
const token = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(100);
export const RuntimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    server: z
      .object({
        publicOrigin: origin,
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(8787),
        chatPath: path.default("/glirastes/chat"),
        maxBodyBytes: z
          .number()
          .int()
          .min(1024)
          .max(8 * 1024 * 1024)
          .default(1024 * 1024),
        maxConcurrentTurns: z.number().int().min(1).max(1000).default(20),
        drainTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
      })
      .strict(),
    application: z
      .object({
        artifact: file,
        apiOrigin: origin,
        allowedPathPrefixes: z.array(path).min(1),
        timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
        maxResponseBytes: z
          .number()
          .int()
          .min(1024)
          .max(8 * 1024 * 1024)
          .default(2 * 1024 * 1024),
        // Upper bound of a serialized tool result for the model; the SDK default (16,000) when absent.
        maxResultChars: z
          .number()
          .int()
          .min(MIN_MAX_RESULT_CHARS)
          .max(MAX_MAX_RESULT_CHARS)
          .optional(),
        // Turn-scoped result handles and read_result (createAiChatHandler resultHandles); on when absent.
        resultHandles: z.boolean().optional(),
      })
      .strict(),
    identity: z
      .object({
        endpoint: path,
        credential: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("cookie"),
              names: z.array(token).min(1).max(10),
            })
            .strict(),
          z.object({ type: z.literal("bearer") }).strict(),
        ]),
        csrfHeader: z.enum(["x-csrf-token", "x-xsrf-token"]).optional(),
      })
      .strict(),
    model: z
      .object({
        name: z.string().min(1).max(200),
        apiKeyFile: file,
        baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
      })
      .strict()
      .refine((m) => {
        const u = new URL(m.baseUrl);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.hash &&
          !u.search
        );
      }),
    approvals: z
      .object({ secretFile: file, connectionStringFile: file })
      .strict(),
    platform: z
      .discriminatedUnion("enabled", [
        z.object({ enabled: z.literal(false) }).strict(),
        z
          .object({
            enabled: z.literal(true),
            environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
            apiKeyFile: file,
            controlPlaneOrigin: origin.optional(),
            requireAcceptedDeployment: z.literal(true).default(true),
          })
          .strict(),
      ])
      .default({ enabled: false }),
    limits: z
      .object({
        maxModelSteps: z.number().int().min(1).max(50).default(6),
        maxToolCalls: z.number().int().min(1).max(100).default(8),
        totalTimeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
        maxInputTokens: z.number().int().min(1).max(200_000).default(40_000),
        maxOutputTokens: z.number().int().min(1).max(32_000).default(4000),
        maxEstimatedCostUsd: z.number().positive().max(100).default(0.5),
      })
      .default({
        maxModelSteps: 6,
        maxToolCalls: 8,
        totalTimeoutMs: 60_000,
        maxInputTokens: 40_000,
        maxOutputTokens: 4000,
        maxEstimatedCostUsd: 0.5,
      }),
  })
  .strict();
export type RuntimeServiceConfig = z.infer<typeof RuntimeConfigSchema>;
export function parseRuntimeConfig(input: unknown): RuntimeServiceConfig {
  const result = RuntimeConfigSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid runtime configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = result.data;
  if (c.application.timeoutMs > c.limits.totalTimeoutMs)
    throw new Error("API timeout exceeds turn timeout");
  if (["/healthz", "/readyz"].includes(c.server.chatPath))
    throw new Error("Chat path conflicts with health endpoint");
  return c;
}
export async function readRuntimeConfig(
  filename: string,
): Promise<RuntimeServiceConfig> {
  return parseRuntimeConfig(JSON.parse(await readFile(filename, "utf8")));
}
export async function readSecret(filename: string): Promise<string> {
  const result = (await readFile(filename, "utf8")).trim();
  if (!result || result.length > 16384) throw new Error("Invalid secret file");
  return result;
}
