import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgresQueryClient } from '../../../runtime/postgres-store.js';
import {
  createMemoryPrivacyMappingStore,
  openEntry,
  parsePrivacyKeyring,
  scopeKeyOf,
  sealEntry,
  type MappingLifetime,
  type PrivacyKeyring,
  type PrivacyMappingStore,
} from '../mapping-store.js';
import { createPostgresPrivacyMappingStore, POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL } from '../postgres-mapping-store.js';
import { createStrictPiiShield } from '../strict-shield.js';
import { CANARY, CANARY_PATTERN, testKeyring, testScope } from './privacy-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.GLIRASTES_TEST_POSTGRES_URL;

function clock(start = Date.parse('2026-11-17T10:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

const entry = (original: string, pseudonym: string, category = 'email') => ({ original, pseudonym, category });

/** Shared behaviour of every mapping store. */
function storeContract(name: string, make: (lifetime: MappingLifetime) => Promise<PrivacyMappingStore>) {
  describe(`${name} mapping store`, () => {
    it('creates, appends and reloads a scope', async () => {
      const store = await make({});
      const scope = testScope();
      const first = await store.load(scope);
      expect(first).toMatchObject({ generation: 1, version: 0, entries: [] });
      const result = await store.append(scope, 1, [entry(CANARY.email, 'lena@example.invalid')]);
      expect(result.notInserted).toEqual([]);
      const again = await store.load(scope);
      expect(again.entries).toEqual([entry(CANARY.email, 'lena@example.invalid')]);
      expect(again.version).toBe(result.version);
    });

    it('never overwrites an existing original or pseudonym', async () => {
      const store = await make({});
      const scope = testScope();
      await store.load(scope);
      await store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')]);
      const result = await store.append(scope, 1, [
        entry('a@example.invalid', 'p2@example.invalid'),
        entry('b@example.invalid', 'p1@example.invalid'),
        entry('c@example.invalid', 'p3@example.invalid'),
      ]);
      expect(result.notInserted.map((e) => e.original).sort()).toEqual(['a@example.invalid', 'b@example.invalid']);
      const { entries } = await store.load(scope);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.original === 'a@example.invalid')?.pseudonym).toBe('p1@example.invalid');
    });

    it('keeps scopes apart: another principal or conversation sees nothing', async () => {
      const store = await make({});
      const scope = testScope();
      await store.load(scope);
      await store.append(scope, 1, [entry(CANARY.email, 'lena@example.invalid')]);
      expect((await store.load({ ...scope, principalId: 'principal-2' })).entries).toEqual([]);
      expect((await store.load({ ...scope, conversationId: 'conv-other' })).entries).toEqual([]);
      expect((await store.load({ ...scope, tenantId: 'tenant-b' })).entries).toEqual([]);
    });

    it('compare-and-set rejects a stale version', async () => {
      const store = await make({});
      const scope = testScope();
      const { version } = await store.load(scope);
      await store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')], { expectedVersion: version });
      await expect(
        store.append(scope, 1, [entry('b@example.invalid', 'p2@example.invalid')], { expectedVersion: version }),
      ).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    });

    it('expires after the idle TTL and restarts as a new generation', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      const scope = testScope();
      await store.load(scope);
      await store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')]);
      c.advance(1_001);
      const restarted = await store.load(scope);
      expect(restarted).toMatchObject({ generation: 2, entries: [] });
      await expect(store.append(scope, 1, [entry('x@example.invalid', 'p9@example.invalid')])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    });

    it('expires at the absolute TTL even while active', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 2_500, now: c.now });
      const scope = testScope();
      await store.load(scope);
      await store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')]);
      for (let i = 0; i < 3; i++) {
        c.advance(900);
        await store.load(scope);
      }
      expect((await store.load(scope)).generation).toBe(2);
    });

    it('a deleted mapping stays deleted: no resurrection by a late append or load', async () => {
      const store = await make({});
      const scope = testScope();
      await store.load(scope);
      await store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')]);
      await store.delete(scope);
      await expect(store.load(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
      await expect(store.append(scope, 1, [entry('b@example.invalid', 'p2@example.invalid')])).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    });

    it('delete versus a concurrent save: either the save lands before or fails, never after', async () => {
      const store = await make({});
      const scope = testScope();
      await store.load(scope);
      const save = store.append(scope, 1, [entry('a@example.invalid', 'p1@example.invalid')]).then(() => 'saved', (e) => e.code);
      const del = store.delete(scope);
      const [saved] = await Promise.all([save, del]);
      expect(['saved', 'privacy_mapping_deleted']).toContain(saved);
      await expect(store.load(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    });

    it('purges expired scopes', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      await store.load(testScope());
      c.advance(5_000);
      expect(await store.purgeExpired(c.now())).toBeGreaterThanOrEqual(1);
    });
  });
}

storeContract('memory', async (lifetime) => createMemoryPrivacyMappingStore(lifetime));

describe('keyring', () => {
  it('parses a valid keyring and rejects malformed input without echoing it', () => {
    const key = randomBytes(32).toString('base64');
    const ring = parsePrivacyKeyring(JSON.stringify({ active: 'k1', keys: { k1: key }, index: key }));
    expect(ring.activeKeyId).toBe('k1');
    for (const bad of [undefined, '', 'not json', '{"active":"k1"}', JSON.stringify({ active: 'k2', keys: { k1: key }, index: key }), JSON.stringify({ active: 'k1', keys: { k1: 'c2hvcnQ=' }, index: key })]) {
      let thrown: unknown;
      try {
        parsePrivacyKeyring(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'privacy_key_unavailable' });
      expect(String((thrown as Error).message)).not.toContain(key);
    }
  });

  it('seals with the scope as associated data: a foreign scope cannot open it', () => {
    const ring = testKeyring();
    const a = scopeKeyOf(testScope());
    const b = scopeKeyOf(testScope());
    const sealed = sealEntry(ring, a, 1, entry(CANARY.email, 'lena@example.invalid'));
    expect(sealed.sealed).not.toContain(CANARY.email);
    expect(openEntry(ring, a, 1, sealed).original).toBe(CANARY.email);
    expect(() => openEntry(ring, b, 1, sealed)).toThrow(expect.objectContaining({ code: 'privacy_key_unavailable' }));
    expect(() => openEntry(ring, a, 2, sealed)).toThrow(expect.objectContaining({ code: 'privacy_key_unavailable' }));
  });
});

describe('migration file', () => {
  it('equals the schema the store initializes', () => {
    const sql = readFileSync(join(here, '..', 'migrations', '001_mapping.sql'), 'utf8');
    expect(sql.trim()).toBe(POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL.trim());
  });
});

describe.skipIf(!url)('postgres mapping store (isolated test database)', () => {
  let pool: Pool;
  let client: PostgresQueryClient;
  const ring = testKeyring();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 20 });
    client = { unsafe: async (sql, params) => (await pool.query(sql, params as unknown[] | undefined)).rows };
    await createPostgresPrivacyMappingStore(client, { keyring: ring }).initialize();
  });
  afterAll(async () => {
    await pool?.end();
  });

  const pg = (lifetime: MappingLifetime = {}, keyring: PrivacyKeyring = ring) =>
    createPostgresPrivacyMappingStore(client, { keyring, ...lifetime });

  storeContract('postgres', async (lifetime) => pg(lifetime));

  it('initialize is idempotent', async () => {
    await pg().initialize();
    await pg().initialize();
  });

  it('stores no plaintext originals or pseudonyms', async () => {
    const store = pg();
    const scope = testScope();
    await store.load(scope);
    await store.append(scope, 1, [entry(CANARY.email, 'lena.unique@example.invalid')]);
    const rows = await client.unsafe<Record<string, unknown>>(
      'SELECT * FROM glirastes_privacy_mapping_entries e JOIN glirastes_privacy_mapping_scopes s USING (scope_key) WHERE scope_key = $1',
      [scopeKeyOf(scope)],
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(CANARY_PATTERN);
    expect(dump).not.toContain('lena.unique@example.invalid');
  });

  it('100 concurrent appends of the same originals converge on one pseudonym each', async () => {
    const scope = testScope();
    await pg().load(scope);
    const originals = Array.from({ length: 10 }, (_, i) => `person${i}@example.invalid`);
    const results = await Promise.all(Array.from({ length: 100 }, async (_, writer) => {
      const shield = createStrictPiiShield({ store: pg(), locale: 'de-DE' });
      const session = await shield.open(scope);
      return session.pseudonymizeText(`Bitte an ${originals[writer % originals.length]} und ${originals[(writer + 3) % originals.length]}`);
    }));
    const { entries } = await pg().load(scope);
    expect(entries).toHaveLength(originals.length);
    const byOriginal = new Map(entries.map((e) => [e.original, e.pseudonym]));
    expect(new Set(byOriginal.values()).size).toBe(originals.length);
    results.forEach((text, writer) => {
      expect(text).toContain(byOriginal.get(originals[writer % originals.length]!)!);
      expect(text).not.toMatch(/person\d@example\.invalid/);
    });
  });

  it('survives a restart: a new store and shield reproduce the same pseudonyms', async () => {
    const scope = testScope();
    const first = await createStrictPiiShield({ store: pg(), locale: 'de-DE' }).open(scope);
    const before = await first.pseudonymizeText(`Kontakt ${CANARY.email}`);
    const fresh = await createStrictPiiShield({ store: pg(), locale: 'de-DE' }).open(scope);
    expect(await fresh.pseudonymizeText(`Kontakt ${CANARY.email}`)).toBe(before);
    expect(fresh.rehydrateText(before)).toBe(`Kontakt ${CANARY.email}`);
  });

  it('rotates keys: old entries stay readable, rewrap moves them to the active key, a missing key fails closed', async () => {
    const scope = testScope();
    const oldId = `old-${randomBytes(4).toString('hex')}`;
    const newId = `new-${randomBytes(4).toString('hex')}`;
    const oldRing: PrivacyKeyring = { activeKeyId: oldId, keys: { [oldId]: randomBytes(32) }, indexKey: randomBytes(32) };
    const store = pg({}, oldRing);
    await store.load(scope);
    await store.append(scope, 1, [entry('rot@example.invalid', 'p-rot@example.invalid')]);
    const newKey = randomBytes(32);
    const rotated: PrivacyKeyring = { activeKeyId: newId, keys: { ...oldRing.keys, [newId]: newKey }, indexKey: oldRing.indexKey };
    const rotatedStore = pg({}, rotated);
    expect((await rotatedStore.load(scope)).entries[0]?.original).toBe('rot@example.invalid');
    expect(await rotatedStore.rewrapEntries(10_000)).toBe(1);
    expect(await rotatedStore.rewrapEntries(10_000)).toBe(0);
    const onlyNew: PrivacyKeyring = { activeKeyId: newId, keys: { [newId]: newKey }, indexKey: oldRing.indexKey };
    expect((await pg({}, onlyNew).load(scope)).entries[0]?.original).toBe('rot@example.invalid');
    const missing: PrivacyKeyring = { activeKeyId: 'k3', keys: { k3: randomBytes(32) }, indexKey: oldRing.indexKey };
    await expect(pg({}, missing).load(scope)).rejects.toMatchObject({ code: 'privacy_key_unavailable' });
  });

  it('a database failure is privacy_mapping_unavailable without the driver message', async () => {
    const broken: PostgresQueryClient = { unsafe: async () => { throw new Error(`connection to ${url} failed for ${CANARY.email}`); } };
    const error = await createPostgresPrivacyMappingStore(broken, { keyring: ring }).load(testScope()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'privacy_mapping_unavailable' });
    expect(String((error as Error).message)).not.toMatch(CANARY_PATTERN);
    expect(String((error as Error).message)).not.toContain('127.0.0.1');
  });
});
