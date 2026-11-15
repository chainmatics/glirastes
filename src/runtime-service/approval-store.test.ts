import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  acquireRuntimeLease,
  createPostgresApprovalStore,
  type ApprovalPgPool,
} from "./approval-store.js";

class FailingClient extends EventEmitter {
  released = false;
  async query(sql: string) {
    if (sql.includes("pg_try_advisory_lock"))
      return { rows: [{ acquired: true }] };
    if (sql.includes("INSERT")) throw new Error("database unavailable");
    return { rows: [] };
  }
  release() {
    this.released = true;
  }
}

describe("Postgres approval store failure boundaries", () => {
  it("validates namespace and quotas before accessing the database", () => {
    const pool = {} as ApprovalPgPool;
    expect(() =>
      createPostgresApprovalStore(pool, { namespace: "" }),
    ).toThrow();
    expect(() =>
      createPostgresApprovalStore(pool, { namespace: "app", maxEntries: 0 }),
    ).toThrow();
  });

  it("rolls back and releases a client when persistence fails", async () => {
    const client = new FailingClient();
    const query = vi.spyOn(client, "query");
    const store = createPostgresApprovalStore(
      { connect: async () => client, query: client.query.bind(client) },
      { namespace: "app" },
    );
    await expect(
      store.consume("approval", Date.now() + 60_000, { scope: "user" }),
    ).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(client.released).toBe(true);
  });

  it("fails readiness and notifies once when the singleton connection is lost", async () => {
    const client = new FailingClient();
    const lost = vi.fn();
    const lease = await acquireRuntimeLease(
      { connect: async () => client, query: client.query.bind(client) },
      "app",
      lost,
    );
    expect(lease.healthy()).toBe(true);
    client.emit("error", new Error("lost"));
    client.emit("end");
    expect(lease.healthy()).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
    await lease.release();
  });
});

const postgresUrl = process.env.GLIRASTES_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)(
  "Postgres approval store with a real database",
  () => {
    let pool: Pool;
    const namespace = `runtime-test-${randomUUID()}`;
    beforeAll(async () => {
      pool = new Pool({ connectionString: postgresUrl, max: 12 });
      await createPostgresApprovalStore(pool, { namespace }).initialize();
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM glirastes_runtime_approval_consumptions WHERE namespace LIKE $1",
        [`${namespace}%`],
      );
      await pool.end();
    });

    it("consumes once under concurrent delivery and after recreating the store", async () => {
      const store = createPostgresApprovalStore(pool, { namespace });
      const expires = Date.now() + 60_000;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.consume("once", expires, { scope: "user" }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await createPostgresApprovalStore(pool, { namespace }).consume(
          "once",
          expires,
          { scope: "other" },
        ),
      ).toBe(false);
      expect(
        await createPostgresApprovalStore(pool, {
          namespace: `${namespace}-other`,
        }).consume("once", expires),
      ).toBe(true);
    });

    it("enforces atomic per-scope and global quotas", async () => {
      const store = createPostgresApprovalStore(pool, {
        namespace: `${namespace}-quota`,
        maxEntries: 2,
        maxEntriesPerScope: 1,
      });
      const expires = Date.now() + 60_000;
      await expect(
        store.consume("a", expires, { scope: "alice" }),
      ).resolves.toBe(true);
      await expect(
        store.consume("b", expires, { scope: "alice" }),
      ).rejects.toThrow(/quota/i);
      await expect(store.consume("b", expires, { scope: "bob" })).resolves.toBe(
        true,
      );
      await expect(
        store.consume("c", expires, { scope: "carol" }),
      ).rejects.toThrow(/quota/i);
    });

    it("does not exceed the global quota under concurrent different approvals", async () => {
      const store = createPostgresApprovalStore(pool, {
        namespace: `${namespace}-race`,
        maxEntries: 2,
      });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          store.consume(`approval-${index}`, Date.now() + 60_000, {
            scope: `user-${index}`,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(6);
    });

    it("cleans expired entries without accepting an already expired approval", async () => {
      const scope = `${namespace}-expiry`;
      const store = createPostgresApprovalStore(pool, {
        namespace: scope,
        maxEntries: 1,
      });
      await pool.query(
        "INSERT INTO glirastes_runtime_approval_consumptions VALUES ($1, $2, $3, clock_timestamp() - interval '1 second')",
        [scope, "old", "user"],
      );
      await expect(
        store.consume("expired", Date.now() - 120_000),
      ).resolves.toBe(false);
      await expect(store.consume("new", Date.now() + 60_000)).resolves.toBe(
        true,
      );
      await expect(store.healthy()).resolves.toBe(true);
    });

    it("retains consumptions for the full 60-second approval clock skew", async () => {
      const store = createPostgresApprovalStore(pool, {
        namespace: `${namespace}-skew`,
      });
      const expiredRecently = Date.now() - 30_000;
      await expect(store.consume("skew", expiredRecently)).resolves.toBe(true);
      await expect(store.consume("skew", expiredRecently)).resolves.toBe(false);
      const row = await pool.query(
        "SELECT keep_until FROM glirastes_runtime_approval_consumptions WHERE namespace = $1",
        [`${namespace}-skew`],
      );
      expect(Number(new Date(row.rows[0].keep_until))).toBeGreaterThan(
        Date.now(),
      );
    });

    it("takes one active lease, releases it, and allows the next process", async () => {
      const first = await acquireRuntimeLease(
        pool,
        `${namespace}-lease`,
        () => {},
      );
      await expect(
        acquireRuntimeLease(pool, `${namespace}-lease`, () => {}),
      ).rejects.toThrow(/active/i);
      expect(first.healthy()).toBe(true);
      await first.release();
      expect(first.healthy()).toBe(false);
      const next = await acquireRuntimeLease(
        pool,
        `${namespace}-lease`,
        () => {},
      );
      await next.release();
    });
  },
);
