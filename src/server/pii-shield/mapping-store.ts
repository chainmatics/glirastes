import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { PrivacyError } from './detection-result.js';

/**
 * Who a mapping belongs to. All five parts together are the access key: a
 * mapping of one principal or conversation is never resolved for another.
 * Every value comes from the authenticated server context, never from the
 * request body alone (the conversation id may be client-chosen because the
 * principal already confines it).
 */
export interface PrivacyScope {
  tenantId: string;
  appId: string;
  environment: string;
  principalId: string;
  conversationId: string;
}

const SCOPE_PART = /^[A-Za-z0-9._:@\-]{1,200}$/;

/** Throws `privacy_scope_invalid` for a missing or malformed part. */
export function assertPrivacyScope(scope: unknown): asserts scope is PrivacyScope {
  if (typeof scope !== 'object' || scope === null) throw new PrivacyError('privacy_scope_invalid');
  for (const key of ['tenantId', 'appId', 'environment', 'principalId', 'conversationId'] as const) {
    const value = (scope as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !SCOPE_PART.test(value)) throw new PrivacyError('privacy_scope_invalid');
  }
}

export function canonicalScope(scope: PrivacyScope): string {
  return JSON.stringify([scope.tenantId, scope.appId, scope.environment, scope.principalId, scope.conversationId]);
}

export function scopeKeyOf(scope: PrivacyScope): string {
  return createHash('sha256').update(canonicalScope(scope)).digest('hex');
}

/** One original ↔ pseudonym pair. Immutable once stored. */
export interface MappingEntry {
  original: string;
  pseudonym: string;
  category: string;
}

export interface MappingSnapshot {
  /** Bumped when an expired mapping restarts; entries of older generations are gone. */
  generation: number;
  /** Bumped by every successful append (compare-and-set token). */
  version: number;
  entries: MappingEntry[];
}

export interface AppendResult {
  version: number;
  /** Requested entries whose original or pseudonym was already taken. */
  notInserted: MappingEntry[];
}

export interface PrivacyMappingStore {
  /** False for the in-memory test store; the protected profile refuses it. */
  readonly persistent: boolean;
  /**
   * Opens the mapping of a scope, creating it when absent. A deleted mapping
   * throws `privacy_mapping_deleted`; an expired one restarts as a new
   * generation without entries (the next turn re-pseudonymizes its history).
   */
  load(scope: PrivacyScope): Promise<MappingSnapshot>;
  /**
   * Adds entries atomically. An original or pseudonym that already exists is
   * not overwritten. With `expectedVersion` the append is a compare-and-set
   * and throws `privacy_mapping_conflict` on a stale version.
   */
  append(
    scope: PrivacyScope,
    generation: number,
    entries: MappingEntry[],
    options?: { expectedVersion?: number },
  ): Promise<AppendResult>;
  /** Tombstones the mapping: later loads and appends throw `privacy_mapping_deleted`. */
  delete(scope: PrivacyScope): Promise<void>;
  /** Removes expired mappings and old tombstones. Returns the number of scopes removed. */
  purgeExpired(now?: Date): Promise<number>;
}

export interface MappingLifetime {
  /** Default 1 h. */
  idleTtlMs?: number;
  /** Default 24 h. */
  absoluteTtlMs?: number;
  /** How long a tombstone blocks resurrection after deletion. Default 24 h. */
  tombstoneTtlMs?: number;
  now?: () => Date;
}

export const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;

/** Digest key of a value for uniqueness: Unicode NFKC, exact case. */
export function normalizeMappingValue(value: string): string {
  return value.normalize('NFKC');
}

// ---------------------------------------------------------------------------
// Keyring and envelope encryption
// ---------------------------------------------------------------------------

export interface PrivacyKeyring {
  /** Key id new entries are encrypted with. */
  activeKeyId: string;
  /** 32-byte AES-256-GCM keys by id; old ids stay for reading until re-wrapped. */
  keys: Readonly<Record<string, Uint8Array>>;
  /** 32-byte HMAC key for value digests; not rotated with the encryption keys. */
  indexKey: Uint8Array;
}

/**
 * Parses `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"},"index":"<base64>"}`.
 * The value is a deployment secret kept outside the database. Throws
 * `privacy_key_unavailable` for anything malformed, without echoing it.
 */
export function parsePrivacyKeyring(serialized: string | undefined): PrivacyKeyring {
  if (!serialized) throw new PrivacyError('privacy_key_unavailable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new PrivacyError('privacy_key_unavailable');
  }
  const record = parsed as { active?: unknown; keys?: unknown; index?: unknown };
  if (typeof record.active !== 'string' || typeof record.keys !== 'object' || record.keys === null || typeof record.index !== 'string') {
    throw new PrivacyError('privacy_key_unavailable');
  }
  const keys: Record<string, Uint8Array> = {};
  for (const [id, value] of Object.entries(record.keys as Record<string, unknown>)) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new PrivacyError('privacy_key_unavailable');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) throw new PrivacyError('privacy_key_unavailable');
    keys[id] = bytes;
  }
  const indexKey = Buffer.from(record.index, 'base64');
  if (!keys[record.active] || indexKey.length !== 32) throw new PrivacyError('privacy_key_unavailable');
  return { activeKeyId: record.active, keys, indexKey };
}

export function valueDigest(keyring: PrivacyKeyring, scopeKey: string, value: string): string {
  return createHmac('sha256', keyring.indexKey)
    .update(scopeKey)
    .update('\u0000')
    .update(normalizeMappingValue(value))
    .digest('hex');
}

export interface SealedEntry {
  keyId: string;
  /** base64(nonce ‖ ciphertext ‖ tag) */
  sealed: string;
}

function aadOf(scopeKey: string, generation: number): Buffer {
  return Buffer.from(`glirastes-privacy-mapping/v1\u0000${scopeKey}\u0000${generation}`);
}

export function sealEntry(keyring: PrivacyKeyring, scopeKey: string, generation: number, entry: MappingEntry): SealedEntry {
  const key = keyring.keys[keyring.activeKeyId];
  if (!key) throw new PrivacyError('privacy_key_unavailable');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadOf(scopeKey, generation));
  const plaintext = Buffer.from(JSON.stringify([entry.original, entry.pseudonym, entry.category]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyId: keyring.activeKeyId,
    sealed: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64'),
  };
}

/** Throws `privacy_key_unavailable` for an unknown key id or a failed authentication. */
export function openEntry(keyring: PrivacyKeyring, scopeKey: string, generation: number, sealed: SealedEntry): MappingEntry {
  const key = keyring.keys[sealed.keyId];
  if (!key) throw new PrivacyError('privacy_key_unavailable');
  try {
    const bytes = Buffer.from(sealed.sealed, 'base64');
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(bytes.length - 16);
    const ciphertext = bytes.subarray(12, bytes.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aadOf(scopeKey, generation));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const [original, pseudonym, category] = JSON.parse(plaintext) as [string, string, string];
    if (typeof original !== 'string' || typeof pseudonym !== 'string' || typeof category !== 'string') {
      throw new Error('malformed');
    }
    return { original, pseudonym, category };
  } catch {
    throw new PrivacyError('privacy_key_unavailable');
  }
}

// ---------------------------------------------------------------------------
// In-memory store (tests only)
// ---------------------------------------------------------------------------

interface MemoryScope {
  generation: number;
  version: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  deletedAt: number | null;
  entries: MappingEntry[];
}

/**
 * Same semantics as the Postgres store, kept in process memory. Not
 * persistent: the protected profile refuses it unless a test opts in.
 */
export function createMemoryPrivacyMappingStore(lifetime: MappingLifetime = {}): PrivacyMappingStore & {
  /** Test hook: number of scopes held. */
  size(): number;
} {
  const idleTtl = lifetime.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const absoluteTtl = lifetime.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
  const tombstoneTtl = lifetime.tombstoneTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
  const now = () => (lifetime.now?.() ?? new Date()).getTime();
  const scopes = new Map<string, MemoryScope>();

  function live(record: MemoryScope, at: number): boolean {
    return record.idleExpiresAt > at && record.absoluteExpiresAt > at;
  }

  return {
    persistent: false,
    size: () => scopes.size,
    async load(scope) {
      assertPrivacyScope(scope);
      const key = scopeKeyOf(scope);
      const at = now();
      let record = scopes.get(key);
      if (record?.deletedAt != null) throw new PrivacyError('privacy_mapping_deleted');
      if (!record || !live(record, at)) {
        record = {
          generation: (record?.generation ?? 0) + 1,
          version: 0,
          idleExpiresAt: Math.min(at + idleTtl, at + absoluteTtl),
          absoluteExpiresAt: at + absoluteTtl,
          deletedAt: null,
          entries: [],
        };
        scopes.set(key, record);
      } else {
        record.idleExpiresAt = Math.min(at + idleTtl, record.absoluteExpiresAt);
      }
      return { generation: record.generation, version: record.version, entries: record.entries.map((e) => ({ ...e })) };
    },
    async append(scope, generation, entries, options) {
      assertPrivacyScope(scope);
      const record = scopes.get(scopeKeyOf(scope));
      const at = now();
      if (record?.deletedAt != null) throw new PrivacyError('privacy_mapping_deleted');
      if (!record || record.generation !== generation || !live(record, at)) throw new PrivacyError('privacy_mapping_conflict');
      if (options?.expectedVersion !== undefined && options.expectedVersion !== record.version) {
        throw new PrivacyError('privacy_mapping_conflict');
      }
      const originals = new Set(record.entries.map((e) => normalizeMappingValue(e.original)));
      const pseudonyms = new Set(record.entries.map((e) => normalizeMappingValue(e.pseudonym)));
      const notInserted: MappingEntry[] = [];
      for (const entry of entries) {
        const o = normalizeMappingValue(entry.original);
        const p = normalizeMappingValue(entry.pseudonym);
        if (originals.has(o) || pseudonyms.has(p)) {
          notInserted.push(entry);
          continue;
        }
        originals.add(o);
        pseudonyms.add(p);
        record.entries.push({ ...entry });
      }
      record.version += 1;
      record.idleExpiresAt = Math.min(at + idleTtl, record.absoluteExpiresAt);
      return { version: record.version, notInserted };
    },
    async delete(scope) {
      assertPrivacyScope(scope);
      const key = scopeKeyOf(scope);
      const at = now();
      const record = scopes.get(key);
      scopes.set(key, {
        generation: record?.generation ?? 1,
        version: (record?.version ?? 0) + 1,
        idleExpiresAt: at + tombstoneTtl,
        absoluteExpiresAt: at + tombstoneTtl,
        deletedAt: at,
        entries: [],
      });
    },
    async purgeExpired(date) {
      const at = (date ?? new Date(now())).getTime();
      let removed = 0;
      for (const [key, record] of scopes) {
        if (!live(record, at)) {
          scopes.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
