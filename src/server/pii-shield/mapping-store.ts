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

/**
 * How a load found the mapping. `created`: no mapping existed (a new
 * conversation, or one whose mapping was purged or lost: the two cannot be
 * told apart). `renewed`: the previous generation expired and a new, empty
 * one started. `continued`: the live generation was loaded.
 */
export type MappingOrigin = 'created' | 'renewed' | 'continued';

export interface MappingSnapshot {
  /**
   * Random id of the live generation, new whenever a mapping starts: on the
   * first load, after expiry and after a purge or loss. Never reused, so
   * bindings and tool receipts of an earlier generation cannot apply again.
   */
  generation: string;
  /** Bumped by every successful append (compare-and-set token). */
  version: number;
  entries: MappingEntry[];
  origin: MappingOrigin;
  /**
   * Keyed digests of the chat content this generation produced or accepted
   * (see `bind`). History outside this set is not sent to a model.
   */
  bindings: ReadonlySet<string>;
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
   * generation without entries or bindings, so history from before is no
   * longer sent to a model (see `origin` and `bindings`).
   *
   * `lifetime` is the effective policy of this turn. It can only shorten the
   * store's own lifetime, and it applies to the existing generation too: a
   * shorter absolute lifetime caps it from the start of the generation, a
   * longer one never extends it.
   */
  load(scope: PrivacyScope, lifetime?: OpenLifetime): Promise<MappingSnapshot>;
  /**
   * Adds entries atomically. An original or pseudonym that already exists is
   * not overwritten. With `expectedVersion` the append is a compare-and-set
   * and throws `privacy_mapping_conflict` on a stale version.
   */
  append(
    scope: PrivacyScope,
    generation: string,
    entries: MappingEntry[],
    options?: { expectedVersion?: number; idleTtlMs?: number },
  ): Promise<AppendResult>;
  /**
   * Keyed digest of one canonical history part, bound to the scope and
   * generation. Not derivable without the store's key, so a client cannot
   * produce a binding for content of its own.
   */
  bindingDigest(scope: PrivacyScope, generation: string, canonical: string): string;
  /**
   * Records content of this generation as known: what the protected path
   * accepted from the principal and what the turn sent back. Throws
   * `privacy_mapping_deleted`, or `privacy_mapping_conflict` when the
   * generation is no longer live.
   */
  bind(scope: PrivacyScope, generation: string, digests: ReadonlyArray<string>): Promise<void>;
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

/** The lifetime one turn's effective policy asks for; see `load`. */
export interface OpenLifetime {
  idleTtlMs?: number;
  absoluteTtlMs?: number;
}

/** The shorter of the store lifetime and the turn's; never longer than the store's. */
export function effectiveTtl(storeTtl: number, requested: number | undefined): number {
  if (requested === undefined) return storeTtl;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new RangeError('A mapping lifetime is a positive whole number of milliseconds');
  return Math.min(storeTtl, requested);
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

/** A new generation id: 128 random bits, never derived from an earlier one. */
export function newGeneration(): string {
  return randomBytes(16).toString('hex');
}

/** Keyed digest of a canonical history part, bound to scope and generation. */
export function bindingDigestWith(key: Uint8Array, scopeKey: string, generation: string, canonical: string): string {
  return createHmac('sha256', key)
    .update('glirastes-privacy-binding/v1\u0000')
    .update(scopeKey)
    .update(`\u0000${generation}\u0000`)
    .update(canonical)
    .digest('hex');
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

function aadOf(scopeKey: string, generation: string): Buffer {
  return Buffer.from(`glirastes-privacy-mapping/v1\u0000${scopeKey}\u0000${generation}`);
}

export function sealEntry(keyring: PrivacyKeyring, scopeKey: string, generation: string, entry: MappingEntry): SealedEntry {
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
export function openEntry(keyring: PrivacyKeyring, scopeKey: string, generation: string, sealed: SealedEntry): MappingEntry {
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
  generation: string;
  generationStartedAt: number;
  version: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  deletedAt: number | null;
  entries: MappingEntry[];
  bindings: Set<string>;
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
  const bindingKey = randomBytes(32);

  function live(record: MemoryScope, at: number): boolean {
    return record.idleExpiresAt > at && record.absoluteExpiresAt > at;
  }

  return {
    persistent: false,
    size: () => scopes.size,
    async load(scope, requested) {
      assertPrivacyScope(scope);
      const idle = effectiveTtl(idleTtl, requested?.idleTtlMs);
      const absolute = effectiveTtl(absoluteTtl, requested?.absoluteTtlMs);
      const key = scopeKeyOf(scope);
      const at = now();
      let record = scopes.get(key);
      if (record?.deletedAt != null) throw new PrivacyError('privacy_mapping_deleted');
      let origin: MappingOrigin = 'continued';
      if (record) {
        // A shorter policy caps the running generation from its start.
        record.absoluteExpiresAt = Math.min(record.absoluteExpiresAt, record.generationStartedAt + absolute);
      }
      if (!record || !live(record, at)) {
        origin = record ? 'renewed' : 'created';
        record = {
          generation: newGeneration(),
          generationStartedAt: at,
          version: 0,
          idleExpiresAt: Math.min(at + idle, at + absolute),
          absoluteExpiresAt: at + absolute,
          deletedAt: null,
          entries: [],
          bindings: new Set(),
        };
        scopes.set(key, record);
      } else {
        record.idleExpiresAt = Math.min(at + idle, record.absoluteExpiresAt);
      }
      return {
        generation: record.generation,
        version: record.version,
        entries: record.entries.map((e) => ({ ...e })),
        origin,
        bindings: new Set(record.bindings),
      };
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
      record.idleExpiresAt = Math.min(at + effectiveTtl(idleTtl, options?.idleTtlMs), record.absoluteExpiresAt);
      return { version: record.version, notInserted };
    },
    bindingDigest(scope, generation, canonical) {
      return bindingDigestWith(bindingKey, scopeKeyOf(scope), generation, canonical);
    },
    async bind(scope, generation, digests) {
      assertPrivacyScope(scope);
      const record = scopes.get(scopeKeyOf(scope));
      const at = now();
      if (record?.deletedAt != null) throw new PrivacyError('privacy_mapping_deleted');
      if (!record || record.generation !== generation || !live(record, at)) throw new PrivacyError('privacy_mapping_conflict');
      for (const digest of digests) record.bindings.add(digest);
    },
    async delete(scope) {
      assertPrivacyScope(scope);
      const key = scopeKeyOf(scope);
      const at = now();
      const record = scopes.get(key);
      scopes.set(key, {
        generation: record?.generation ?? newGeneration(),
        generationStartedAt: record?.generationStartedAt ?? at,
        version: (record?.version ?? 0) + 1,
        idleExpiresAt: at + tombstoneTtl,
        absoluteExpiresAt: at + tombstoneTtl,
        deletedAt: at,
        entries: [],
        bindings: new Set(),
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
