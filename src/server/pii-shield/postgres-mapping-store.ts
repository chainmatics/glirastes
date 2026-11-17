import type { PostgresQueryClient } from '../../runtime/postgres-store.js';
import { PrivacyError, isPrivacyError } from './detection-result.js';
import {
  assertPrivacyScope,
  bindingDigestWith,
  DEFAULT_ABSOLUTE_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  effectiveTtl,
  newGeneration,
  openEntry,
  scopeKeyOf,
  sealEntry,
  valueDigest,
  type MappingEntry,
  type MappingLifetime,
  type MappingOrigin,
  type PrivacyKeyring,
  type PrivacyMappingStore,
} from './mapping-store.js';

/**
 * Schema of the scoped privacy mapping (also in `migrations/001_mapping.sql`).
 * Values are AES-256-GCM sealed with the scope as associated data; only
 * keyed digests are stored in clear for uniqueness. Every original and
 * pseudonym digest is also a row of the tokens table, so no value can be an
 * original in one entry and a pseudonym in another, even under concurrent
 * appends. Bindings are keyed digests of the chat content a generation
 * produced or accepted; they hold no content. The database role needs SELECT,
 * INSERT, UPDATE and DELETE on these four tables only.
 */
export const POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL = `/* glirastes:privacy-mapping-schema */
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_scopes (
  scope_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  environment text NOT NULL,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  generation text NOT NULL,
  generation_started_at timestamptz,
  version bigint NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- Tables created before per-turn lifetimes; NULL reads as created_at (never later).
ALTER TABLE glirastes_privacy_mapping_scopes ADD COLUMN IF NOT EXISTS generation_started_at timestamptz;
CREATE INDEX IF NOT EXISTS glirastes_privacy_mapping_scopes_principal_idx
  ON glirastes_privacy_mapping_scopes (tenant_id, principal_id);
CREATE INDEX IF NOT EXISTS glirastes_privacy_mapping_scopes_expiry_idx
  ON glirastes_privacy_mapping_scopes (idle_expires_at);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_entries (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  original_digest text NOT NULL,
  pseudonym_digest text NOT NULL,
  key_id text NOT NULL,
  sealed text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope_key, generation, original_digest),
  UNIQUE (scope_key, generation, pseudonym_digest)
);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_tokens (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (scope_key, generation, digest)
);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_bindings (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope_key, generation, digest)
);
`;

export interface PostgresPrivacyMappingStoreOptions extends MappingLifetime {
  keyring: PrivacyKeyring;
}

function at(date: Date, offsetMs: number): string {
  return new Date(date.getTime() + offsetMs).toISOString();
}

/** A unique violation inside an append: a concurrent append took a value; retried. */
class TokenTaken extends Error {}

const APPEND_ATTEMPTS = 3;

/**
 * Persistent scoped mapping in the consumer's own Postgres. An append is one
 * atomic statement that locks the scope row, so appends and a delete of the
 * same scope serialize and a tombstone is never overwritten by a late
 * append. A delete first writes the tombstone (waiting for running appends)
 * and then removes the entries in a second statement that sees everything
 * committed before it. Database errors surface as
 * `privacy_mapping_unavailable` without their text.
 */
export function createPostgresPrivacyMappingStore(
  client: PostgresQueryClient,
  options: PostgresPrivacyMappingStoreOptions,
): PrivacyMappingStore & {
  initialize(): Promise<void>;
  /**
   * Re-encrypts entries sealed with an older key of this keyring under the
   * active key. Returns the count; run until it returns 0 before removing the
   * old key. Entries of key ids the keyring does not hold are left untouched.
   */
  rewrapEntries(limit?: number): Promise<number>;
} {
  const { keyring } = options;
  const idleTtl = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const absoluteTtl = options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
  const tombstoneTtl = options.tombstoneTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
  const now = () => options.now?.() ?? new Date();

  async function query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      return params ? await client.unsafe<T>(sql, params) : await client.unsafe<T>(sql);
    } catch (error) {
      if (isPrivacyError(error)) throw error;
      if ((error as { code?: unknown } | null)?.code === '23505') throw new TokenTaken();
      throw new PrivacyError('privacy_mapping_unavailable');
    }
  }

  async function failureOf(scopeKey: string): Promise<PrivacyError> {
    const rows = await query<{ deleted: boolean }>(
      `/* glirastes:privacy-mapping-state */
SELECT deleted_at IS NOT NULL AS deleted FROM glirastes_privacy_mapping_scopes WHERE scope_key = $1`,
      [scopeKey],
    );
    return new PrivacyError(rows[0]?.deleted ? 'privacy_mapping_deleted' : 'privacy_mapping_conflict');
  }

  return {
    persistent: true,

    async initialize() {
      await query(POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL);
    },

    async load(scope, requested) {
      assertPrivacyScope(scope);
      const idle = effectiveTtl(idleTtl, requested?.idleTtlMs);
      const absolute = effectiveTtl(absoluteTtl, requested?.absoluteTtlMs);
      const scopeKey = scopeKeyOf(scope);
      const date = now();
      const nowIso = date.toISOString();
      // cap: the running generation's absolute expiry under this turn's
      // policy. A shorter absolute lifetime counts from the generation's
      // start; a longer one never extends the stored expiry.
      const cap = `LEAST(s.absolute_expires_at,
    COALESCE(s.generation_started_at, s.created_at) + ($11::bigint * interval '1 millisecond'))`;
      const expired = `(s.idle_expires_at <= $7::timestamptz OR ${cap} <= $7::timestamptz)`;
      const rows = await query<{ generation: string; version: string | number; deleted: boolean; created: boolean; fresh: boolean }>(
        `/* glirastes:privacy-mapping-load */
INSERT INTO glirastes_privacy_mapping_scopes AS s
  (scope_key, tenant_id, app_id, environment, principal_id, conversation_id,
   generation, generation_started_at, version, idle_expires_at, absolute_expires_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $10, $7::timestamptz, 0, LEAST($8::timestamptz, $9::timestamptz), $9::timestamptz, $7::timestamptz, $7::timestamptz)
ON CONFLICT (scope_key) DO UPDATE SET
  generation = CASE WHEN s.deleted_at IS NULL AND ${expired} THEN $10 ELSE s.generation END,
  generation_started_at = CASE
    WHEN s.deleted_at IS NULL AND ${expired} THEN $7::timestamptz ELSE s.generation_started_at END,
  version = CASE WHEN s.deleted_at IS NULL AND ${expired} THEN 0 ELSE s.version END,
  absolute_expires_at = CASE
    WHEN s.deleted_at IS NOT NULL THEN s.absolute_expires_at
    WHEN ${expired} THEN $9::timestamptz
    ELSE ${cap} END,
  idle_expires_at = CASE
    WHEN s.deleted_at IS NOT NULL THEN s.idle_expires_at
    WHEN ${expired} THEN LEAST($8::timestamptz, $9::timestamptz)
    ELSE LEAST($8::timestamptz, ${cap}) END,
  updated_at = $7::timestamptz
RETURNING generation, version, deleted_at IS NOT NULL AS deleted, (xmax = 0) AS created,
  -- The subquery reads the row as it was before this statement.
  generation <> COALESCE((SELECT o.generation FROM glirastes_privacy_mapping_scopes o WHERE o.scope_key = $1), generation) AS fresh`,
        [
          scopeKey, scope.tenantId, scope.appId, scope.environment, scope.principalId, scope.conversationId,
          nowIso, at(date, idle), at(date, absolute), newGeneration(), absolute,
        ],
      );
      const header = rows[0];
      if (!header) throw new PrivacyError('privacy_mapping_unavailable');
      if (header.deleted) throw new PrivacyError('privacy_mapping_deleted');
      const generation = String(header.generation);
      const origin: MappingOrigin = header.created ? 'created' : header.fresh ? 'renewed' : 'continued';
      // Header state, entries and bindings in one statement, so one snapshot:
      // a delete that committed in between is seen as deleted instead of
      // as an empty, live mapping.
      const contentRows = await query<{ generation: string; deleted: boolean; entries: Array<[string, string]>; bindings: string[] }>(
        `/* glirastes:privacy-mapping-entries */
SELECT s.generation, s.deleted_at IS NOT NULL AS deleted,
  COALESCE((SELECT json_agg(json_build_array(e.key_id, e.sealed) ORDER BY e.created_at, e.original_digest)
    FROM glirastes_privacy_mapping_entries e WHERE e.scope_key = $1 AND e.generation = $2), '[]'::json) AS entries,
  COALESCE((SELECT array_agg(b.digest) FROM glirastes_privacy_mapping_bindings b
    WHERE b.scope_key = $1 AND b.generation = $2), '{}'::text[]) AS bindings
FROM glirastes_privacy_mapping_scopes s WHERE s.scope_key = $1`,
        [scopeKey, generation],
      );
      const content = contentRows[0];
      if (!content || content.deleted) throw new PrivacyError('privacy_mapping_deleted');
      if (String(content.generation) !== generation) throw new PrivacyError('privacy_mapping_conflict');
      const entries = content.entries.map(([keyId, sealed]) => openEntry(keyring, scopeKey, generation, { keyId, sealed }));
      // Entries of an expired generation are not readable any more; remove them.
      await query(
        `/* glirastes:privacy-mapping-old-generations */
WITH tokens AS (
  DELETE FROM glirastes_privacy_mapping_tokens WHERE scope_key = $1 AND generation <> $2
), bindings AS (
  DELETE FROM glirastes_privacy_mapping_bindings WHERE scope_key = $1 AND generation <> $2
)
DELETE FROM glirastes_privacy_mapping_entries WHERE scope_key = $1 AND generation <> $2`,
        [scopeKey, generation],
      );
      return { generation, version: Number(header.version), entries, origin, bindings: new Set(content.bindings) };
    },

    async append(scope, generation, entries, appendOptions) {
      assertPrivacyScope(scope);
      const scopeKey = scopeKeyOf(scope);
      const date = now();
      const nowIso = date.toISOString();
      const unique: MappingEntry[] = [];
      const seenOriginal = new Set<string>();
      const seenPseudonym = new Set<string>();
      const notInserted: MappingEntry[] = [];
      for (const entry of entries) {
        const o = valueDigest(keyring, scopeKey, entry.original);
        const p = valueDigest(keyring, scopeKey, entry.pseudonym);
        if (seenOriginal.has(o) || seenPseudonym.has(p) || seenOriginal.has(p) || seenPseudonym.has(o)) {
          notInserted.push(entry);
          continue;
        }
        seenOriginal.add(o);
        seenPseudonym.add(p);
        unique.push(entry);
      }
      const originalDigests = unique.map((e) => valueDigest(keyring, scopeKey, e.original));
      const pseudonymDigests = unique.map((e) => valueDigest(keyring, scopeKey, e.pseudonym));
      const sealed = unique.map((e) => sealEntry(keyring, scopeKey, generation, e));
      const params = [
        scopeKey, generation, at(date, effectiveTtl(idleTtl, appendOptions?.idleTtlMs)), nowIso,
        appendOptions?.expectedVersion ?? null,
        originalDigests, pseudonymDigests, sealed.map((s) => s.keyId), sealed.map((s) => s.sealed),
      ];
      // A token another append committed after this statement's snapshot
      // raises a unique violation and rolls the whole statement back; the
      // retry sees it and leaves the entry out instead.
      let rows: Array<{ version: string | number | null; inserted: string[] | null }> | undefined;
      for (let attempt = 1; !rows; attempt += 1) {
        try {
          rows = await query<{ version: string | number | null; inserted: string[] | null }>(
        `/* glirastes:privacy-mapping-append */
WITH header AS (
  UPDATE glirastes_privacy_mapping_scopes
  SET version = version + 1,
      idle_expires_at = LEAST($3::timestamptz, absolute_expires_at),
      updated_at = $4::timestamptz
  WHERE scope_key = $1
    AND generation = $2
    AND deleted_at IS NULL
    AND idle_expires_at > $4::timestamptz
    AND absolute_expires_at > $4::timestamptz
    AND ($5::bigint IS NULL OR version = $5::bigint)
  RETURNING scope_key, generation, version
), candidate AS (
  SELECT e.original_digest, e.pseudonym_digest, e.key_id, e.sealed
  FROM unnest($6::text[], $7::text[], $8::text[], $9::text[]) AS e(original_digest, pseudonym_digest, key_id, sealed)
  WHERE NOT EXISTS (
    SELECT 1 FROM glirastes_privacy_mapping_entries x
    WHERE x.scope_key = $1 AND x.generation = $2
      AND (x.original_digest = e.pseudonym_digest OR x.pseudonym_digest = e.original_digest)
  )
), inserted AS (
  INSERT INTO glirastes_privacy_mapping_entries
    (scope_key, generation, original_digest, pseudonym_digest, key_id, sealed, created_at)
  SELECT h.scope_key, h.generation, c.original_digest, c.pseudonym_digest, c.key_id, c.sealed, $4::timestamptz
  FROM header h CROSS JOIN candidate c
  ON CONFLICT DO NOTHING
  RETURNING original_digest, pseudonym_digest
), tokens AS (
  INSERT INTO glirastes_privacy_mapping_tokens (scope_key, generation, digest)
  SELECT $1, $2, t.digest
  FROM inserted i CROSS JOIN LATERAL (VALUES (i.original_digest), (i.pseudonym_digest)) AS t(digest)
)
SELECT (SELECT version FROM header) AS version,
       (SELECT array_agg(original_digest) FROM inserted) AS inserted`,
            params,
          );
        } catch (error) {
          if (!(error instanceof TokenTaken)) throw error;
          if (attempt >= APPEND_ATTEMPTS) throw new PrivacyError('privacy_mapping_conflict');
        }
      }
      const result = rows[0];
      if (!result || result.version === null || result.version === undefined) throw await failureOf(scopeKey);
      const inserted = new Set(result.inserted ?? []);
      unique.forEach((entry, index) => {
        if (!inserted.has(originalDigests[index]!)) notInserted.push(entry);
      });
      return { version: Number(result.version), notInserted };
    },

    bindingDigest(scope, generation, canonical) {
      return bindingDigestWith(keyring.indexKey, scopeKeyOf(scope), generation, canonical);
    },

    async bind(scope, generation, digests) {
      assertPrivacyScope(scope);
      if (digests.length === 0) return;
      const scopeKey = scopeKeyOf(scope);
      const nowIso = now().toISOString();
      // The share lock orders a bind before a concurrent tombstone, whose
      // second statement then removes the bindings with the entries.
      const rows = await query<{ live: string | number }>(
        `/* glirastes:privacy-mapping-bind */
WITH header AS (
  SELECT scope_key, generation FROM glirastes_privacy_mapping_scopes
  WHERE scope_key = $1 AND generation = $2 AND deleted_at IS NULL
    AND idle_expires_at > $3::timestamptz AND absolute_expires_at > $3::timestamptz
  FOR SHARE
), inserted AS (
  INSERT INTO glirastes_privacy_mapping_bindings (scope_key, generation, digest, created_at)
  SELECT h.scope_key, h.generation, d.digest, $3::timestamptz
  FROM header h CROSS JOIN unnest($4::text[]) AS d(digest)
  ON CONFLICT DO NOTHING
)
SELECT count(*) AS live FROM header`,
        [scopeKey, generation, nowIso, [...new Set(digests)]],
      );
      if (Number(rows[0]?.live ?? 0) === 0) throw await failureOf(scopeKey);
    },

    async delete(scope) {
      assertPrivacyScope(scope);
      const scopeKey = scopeKeyOf(scope);
      const date = now();
      const nowIso = date.toISOString();
      const until = at(date, tombstoneTtl);
      // 1. The tombstone waits for appends holding the scope row and blocks all later ones.
      await query(
        `/* glirastes:privacy-mapping-delete */
INSERT INTO glirastes_privacy_mapping_scopes AS s
  (scope_key, tenant_id, app_id, environment, principal_id, conversation_id,
   generation, version, idle_expires_at, absolute_expires_at, deleted_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $9, 1, $8::timestamptz, $8::timestamptz, $7::timestamptz, $7::timestamptz, $7::timestamptz)
ON CONFLICT (scope_key) DO UPDATE SET
  version = s.version + 1,
  deleted_at = COALESCE(s.deleted_at, $7::timestamptz),
  idle_expires_at = $8::timestamptz,
  absolute_expires_at = $8::timestamptz,
  updated_at = $7::timestamptz`,
        [scopeKey, scope.tenantId, scope.appId, scope.environment, scope.principalId, scope.conversationId, nowIso, until, newGeneration()],
      );
      // 2. A new statement, so it sees every entry committed before the tombstone.
      //    If it fails, the tombstone already refuses the scope; a retried delete finishes it.
      await query(
        `/* glirastes:privacy-mapping-delete-entries */
WITH tokens AS (
  DELETE FROM glirastes_privacy_mapping_tokens WHERE scope_key = $1
), bindings AS (
  DELETE FROM glirastes_privacy_mapping_bindings WHERE scope_key = $1
)
DELETE FROM glirastes_privacy_mapping_entries WHERE scope_key = $1`,
        [scopeKey],
      );
    },

    async purgeExpired(date) {
      const nowIso = (date ?? now()).toISOString();
      const rows = await query<{ scope_key: string }>(
        `/* glirastes:privacy-mapping-purge */
DELETE FROM glirastes_privacy_mapping_scopes
WHERE idle_expires_at <= $1::timestamptz OR absolute_expires_at <= $1::timestamptz
RETURNING scope_key`,
        [nowIso],
      );
      return rows.length;
    },

    async rewrapEntries(limit = 500) {
      const rows = await query<{ scope_key: string; generation: string; original_digest: string; key_id: string; sealed: string }>(
        `/* glirastes:privacy-mapping-rewrap-select */
SELECT scope_key, generation, original_digest, key_id, sealed FROM glirastes_privacy_mapping_entries
WHERE key_id <> $1 AND key_id = ANY($3::text[]) LIMIT $2`,
        [keyring.activeKeyId, limit, Object.keys(keyring.keys)],
      );
      let count = 0;
      for (const row of rows) {
        const generation = String(row.generation);
        const entry = openEntry(keyring, row.scope_key, generation, { keyId: row.key_id, sealed: row.sealed });
        const resealed = sealEntry(keyring, row.scope_key, generation, entry);
        const updated = await query(
          `/* glirastes:privacy-mapping-rewrap */
UPDATE glirastes_privacy_mapping_entries SET key_id = $4, sealed = $5
WHERE scope_key = $1 AND generation = $2 AND original_digest = $3 AND key_id = $6
RETURNING 1`,
          [row.scope_key, generation, row.original_digest, resealed.keyId, resealed.sealed, row.key_id],
        );
        count += updated.length;
      }
      return count;
    },
  };
}
