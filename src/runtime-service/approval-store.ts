import { createHash } from "node:crypto";
import type { ApprovalStore } from "../server/adapters/nextjs/approval-binding.js";

/** Narrow interfaces allow a customer's pool without coupling the SDK to pg. */
export interface ApprovalPgQuery {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface ApprovalPgClient extends ApprovalPgQuery {
  release(error?: Error | boolean): void;
  on(event: "error" | "end", listener: (...args: unknown[]) => void): unknown;
}
export interface ApprovalPgPool extends ApprovalPgQuery {
  connect(): Promise<ApprovalPgClient>;
}

export interface PostgresApprovalStoreOptions {
  /** Stable per application/environment; never supplied by an HTTP caller. */
  namespace: string;
  maxEntries?: number;
  maxEntriesPerScope?: number;
}
export interface PostgresApprovalStore extends ApprovalStore {
  initialize(): Promise<void>;
  healthy(): Promise<boolean>;
}

// Keep in step with approval-binding.ts: ids remain replay-blocked throughout
// its accepted clock skew, including across process restarts.
const APPROVAL_CLOCK_SKEW_MS = 60_000;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS glirastes_runtime_approval_consumptions (
  namespace text NOT NULL,
  approval_hash text NOT NULL,
  scope text NOT NULL,
  keep_until timestamptz NOT NULL,
  PRIMARY KEY (namespace, approval_hash)
);
CREATE INDEX IF NOT EXISTS glirastes_runtime_approval_expiry_idx
  ON glirastes_runtime_approval_consumptions (namespace, keep_until);
CREATE INDEX IF NOT EXISTS glirastes_runtime_approval_scope_idx
  ON glirastes_runtime_approval_consumptions (namespace, scope);
`;

function namespaceOf(namespace: string): string {
  if (!namespace || namespace.length > 512)
    throw new Error("Invalid runtime store namespace");
  return namespace;
}
function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid approval store quota");
  return value;
}
function lockKeys(
  namespace: string,
  purpose: "approval" | "runner",
): [number, number] {
  const digest = createHash("sha256")
    .update(JSON.stringify(["glirastes-runtime-v1", purpose, namespace]))
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Persistent single-use approval consumption. A transaction lock serializes
 * quota checks and insertions for this app/environment, including across pools.
 * It never grants authorization: only the SDK binder calls consume after
 * verifying the signed approval and the current principal.
 */
export function createPostgresApprovalStore(
  pool: ApprovalPgPool,
  options: PostgresApprovalStoreOptions,
): PostgresApprovalStore {
  const namespace = namespaceOf(options.namespace);
  const maxEntries = positiveLimit(options.maxEntries ?? 20_000);
  const maxEntriesPerScope = positiveLimit(options.maxEntriesPerScope ?? 200);
  const lock = lockKeys(namespace, "approval");
  return {
    async initialize() {
      await pool.query(SCHEMA_SQL);
    },
    async healthy() {
      try {
        await pool.query(
          "SELECT 1 FROM glirastes_runtime_approval_consumptions LIMIT 0",
        );
        return true;
      } catch {
        return false;
      }
    },
    async consume(approvalId, expiresAtMs, context) {
      if (
        !approvalId ||
        approvalId.length > 1024 ||
        !Number.isSafeInteger(expiresAtMs)
      ) {
        throw new Error("Invalid verified approval");
      }
      const keepUntil = new Date(expiresAtMs + APPROVAL_CLOCK_SKEW_MS);
      if (!Number.isFinite(keepUntil.getTime()))
        throw new Error("Invalid approval expiry");
      const scope = context?.scope ?? "";
      if (scope.length > 4096) throw new Error("Invalid approval scope");
      const hash = createHash("sha256").update(approvalId).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", lock);
        await client.query(
          "DELETE FROM glirastes_runtime_approval_consumptions WHERE namespace = $1 AND keep_until < clock_timestamp()",
          [namespace],
        );
        const existing = await client.query(
          "SELECT 1 FROM glirastes_runtime_approval_consumptions WHERE namespace = $1 AND approval_hash = $2",
          [namespace, hash],
        );
        if (existing.rows.length > 0) {
          await client.query("COMMIT");
          return false;
        }
        const counts = await client.query(
          "SELECT count(*) AS total, count(*) FILTER (WHERE scope = $2) AS scoped FROM glirastes_runtime_approval_consumptions WHERE namespace = $1",
          [namespace, scope],
        );
        if (
          Number(counts.rows[0]?.total ?? 0) >= maxEntries ||
          Number(counts.rows[0]?.scoped ?? 0) >= maxEntriesPerScope
        ) {
          throw new Error("Approval store quota exceeded");
        }
        const inserted = await client.query(
          `INSERT INTO glirastes_runtime_approval_consumptions (namespace, approval_hash, scope, keep_until)
           SELECT $1, $2, $3, $4::timestamptz WHERE $4::timestamptz >= clock_timestamp()
           ON CONFLICT DO NOTHING RETURNING approval_hash`,
          [namespace, hash, scope, keepUntil.toISOString()],
        );
        await client.query("COMMIT");
        return inserted.rows.length === 1;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* retain the original error */
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface RuntimeLease {
  healthy(): boolean;
  /** Probe the dedicated connection; hosts should check this for readiness. */
  check(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * One active process for each app/environment. The advisory lock lives on a
 * dedicated connection, never on a pooled query. A connection loss immediately
 * invalidates the lease and tells the host to stop accepting/abort work. This
 * is a deployment guard for V1, not a high-availability/fencing protocol.
 */
export async function acquireRuntimeLease(
  pool: ApprovalPgPool,
  namespace: string,
  onLost: () => void,
): Promise<RuntimeLease> {
  const keys = lockKeys(namespaceOf(namespace), "runner");
  const client = await pool.connect();
  let held = false;
  let released = false;
  let stopped = false;
  const lose = () => {
    if (stopped) return;
    stopped = true;
    held = false;
    if (!released) {
      released = true;
      client.release(true);
    }
    try {
      onLost();
    } catch {
      /* callback must not become an unhandled pg error */
    }
  };
  client.on("error", lose);
  client.on("end", lose);
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      keys,
    );
    if (stopped || result.rows[0]?.acquired !== true)
      throw new Error(
        "Another runtime is already active for this application/environment",
      );
    held = true;
  } catch (error) {
    stopped = true;
    if (!released) {
      released = true;
      client.release(true);
    }
    throw error;
  }
  return {
    healthy: () => held && !stopped,
    async check() {
      if (!held || stopped) return false;
      try {
        await client.query("SELECT 1");
      } catch {
        lose();
      }
      return held && !stopped;
    },
    async release() {
      if (stopped) return;
      stopped = true;
      held = false;
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", keys);
      } finally {
        // Destroy the dedicated connection even when unlock failed: never put
        // an unknown advisory-lock state back into a pool.
        if (!released) {
          released = true;
          client.release(true);
        }
      }
    },
  };
}
