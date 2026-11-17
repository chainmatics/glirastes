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
// CI sets GLIRASTES_REQUIRE_POSTGRES: a missing database must fail there, not skip.
if (process.env.GLIRASTES_REQUIRE_POSTGRES === '1' && !url) throw new Error('GLIRASTES_TEST_POSTGRES_URL is required');

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
      expect(first).toMatchObject({ version: 0, entries: [] });
      expect(first.generation).toMatch(/^[0-9a-f]{32}$/);
      const result = await store.append(scope, first.generation, [entry(CANARY.email, 'lena@example.invalid')]);
      expect(result.notInserted).toEqual([]);
      const again = await store.load(scope);
      expect(again.entries).toEqual([entry(CANARY.email, 'lena@example.invalid')]);
      expect(again.version).toBe(result.version);
    });

    it('never overwrites an existing original or pseudonym', async () => {
      const store = await make({});
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]);
      const result = await store.append(scope, g, [
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
      const g = (await store.load(scope)).generation;
      await store.append(scope, g, [entry(CANARY.email, 'lena@example.invalid')]);
      expect((await store.load({ ...scope, principalId: 'principal-2' })).entries).toEqual([]);
      expect((await store.load({ ...scope, conversationId: 'conv-other' })).entries).toEqual([]);
      expect((await store.load({ ...scope, tenantId: 'tenant-b' })).entries).toEqual([]);
    });

    it('compare-and-set rejects a stale version', async () => {
      const store = await make({});
      const scope = testScope();
      const { version, generation: g } = await store.load(scope);
      await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')], { expectedVersion: version });
      await expect(
        store.append(scope, g, [entry('b@example.invalid', 'p2@example.invalid')], { expectedVersion: version }),
      ).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    });

    it('expires after the idle TTL and restarts as a new generation', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]);
      c.advance(1_001);
      const restarted = await store.load(scope);
      expect(restarted).toMatchObject({ entries: [] });
      expect(restarted.generation).not.toBe(g);
      await expect(store.append(scope, g, [entry('x@example.invalid', 'p9@example.invalid')])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    });

    it('expires at the absolute TTL even while active', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 2_500, now: c.now });
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]);
      for (let i = 0; i < 3; i++) {
        c.advance(900);
        await store.load(scope);
      }
      expect((await store.load(scope)).generation).not.toBe(g);
    });

    it('a deleted mapping stays deleted: no resurrection by a late append or load', async () => {
      const store = await make({});
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]);
      await store.delete(scope);
      await expect(store.load(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
      await expect(store.append(scope, g, [entry('b@example.invalid', 'p2@example.invalid')])).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    });

    it('delete versus a concurrent save: either the save lands before or fails, never after', async () => {
      const store = await make({});
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      const save = store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]).then(() => 'saved', (e) => e.code);
      const del = store.delete(scope);
      const [saved] = await Promise.all([save, del]);
      expect(['saved', 'privacy_mapping_deleted']).toContain(saved);
      await expect(store.load(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    });

    it('reports how a load found the mapping: created, continued, renewed; purged looks created', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      const scope = testScope();
      expect((await store.load(scope)).origin).toBe('created');
      expect((await store.load(scope)).origin).toBe('continued');
      c.advance(1_001);
      expect((await store.load(scope)).origin).toBe('renewed');
      expect((await store.load(scope)).origin).toBe('continued');
      const before = (await store.load(scope)).generation;
      c.advance(20_000);
      await store.purgeExpired(c.now());
      const recreated = await store.load(scope);
      expect(recreated.origin).toBe('created');
      // A mapping created again after a purge or loss never reuses a generation id.
      expect(recreated.generation).not.toBe(before);
    });

    it('binds content per scope and generation; a renewed generation starts without bindings', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      const scope = testScope();
      const g = (await store.load(scope)).generation;
      const digest = store.bindingDigest(scope, g, '["text","Hallo"]');
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(store.bindingDigest(scope, 'other-generation', '["text","Hallo"]')).not.toBe(digest);
      expect(store.bindingDigest(testScope({ conversationId: 'conv-other' }), g, '["text","Hallo"]')).not.toBe(digest);
      await store.bind(scope, g, [digest]);
      expect((await store.load(scope)).bindings.has(digest)).toBe(true);
      c.advance(1_001);
      const renewed = await store.load(scope);
      expect(renewed.bindings.size).toBe(0);
      await expect(store.bind(scope, g, [digest])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
      await store.delete(scope);
      await expect(store.bind(scope, renewed.generation, [digest])).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    });

    it('purges expired scopes', async () => {
      const c = clock();
      const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
      await store.load(testScope());
      c.advance(5_000);
      expect(await store.purgeExpired(c.now())).toBeGreaterThanOrEqual(1);
    });

    describe('lifetime per open (effective policy of the turn)', () => {
      it('a shorter absolute lifetime caps the running generation from its start', async () => {
        const c = clock();
        const store = await make({ idleTtlMs: 60_000, absoluteTtlMs: 100_000, now: c.now });
        const scope = testScope();
        const g = (await store.load(scope)).generation;
        await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')]);
        c.advance(30_000);
        // The policy now allows 20 s in total: the generation started 30 s ago.
        const renewed = await store.load(scope, { absoluteTtlMs: 20_000 });
        expect(renewed.origin).toBe('renewed');
        expect(renewed.generation).not.toBe(g);
        expect(renewed.entries).toEqual([]);
        await expect(store.append(scope, g, [entry('x@example.invalid', 'p9@example.invalid')]))
          .rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
      });

      it('a shortened cap stays when a later turn asks for more', async () => {
        const c = clock();
        const store = await make({ idleTtlMs: 60_000, absoluteTtlMs: 100_000, now: c.now });
        const scope = testScope();
        const g = (await store.load(scope)).generation;
        c.advance(5_000);
        expect((await store.load(scope, { absoluteTtlMs: 20_000 })).generation).toBe(g);
        c.advance(5_000);
        // Back to the store default: the stored expiry (start + 20 s) is not extended.
        expect((await store.load(scope)).generation).toBe(g);
        c.advance(10_001);
        expect((await store.load(scope)).origin).toBe('renewed');
      });

      it('a longer lifetime than the store allows is never applied', async () => {
        const c = clock();
        const store = await make({ idleTtlMs: 1_000, absoluteTtlMs: 10_000, now: c.now });
        const scope = testScope();
        const g = (await store.load(scope, { idleTtlMs: 50_000, absoluteTtlMs: 500_000 })).generation;
        c.advance(1_001);
        expect((await store.load(scope, { idleTtlMs: 50_000 })).generation).not.toBe(g);
      });

      it('a shorter idle lifetime applies to load and append', async () => {
        const c = clock();
        const store = await make({ idleTtlMs: 60_000, absoluteTtlMs: 100_000, now: c.now });
        const scope = testScope();
        const g = (await store.load(scope, { idleTtlMs: 2_000 })).generation;
        c.advance(1_500);
        await store.append(scope, g, [entry('a@example.invalid', 'p1@example.invalid')], { idleTtlMs: 2_000 });
        c.advance(1_500);
        // Idle is sliding: the append 1.5 s ago kept it alive.
        expect((await store.load(scope, { idleTtlMs: 2_000 })).generation).toBe(g);
        c.advance(2_001);
        expect((await store.load(scope, { idleTtlMs: 2_000 })).origin).toBe('renewed');
      });

      it('a shortened generation is purged at its capped expiry', async () => {
        const c = clock();
        const store = await make({ idleTtlMs: 60_000, absoluteTtlMs: 100_000, now: c.now });
        const scope = testScope();
        await store.load(scope, { absoluteTtlMs: 3_000 });
        c.advance(3_001);
        expect(await store.purgeExpired(c.now())).toBeGreaterThanOrEqual(1);
        expect((await store.load(scope)).origin).toBe('created');
      });

      it('refuses a lifetime that is not a positive whole number of milliseconds', async () => {
        const store = await make({});
        await expect(store.load(testScope(), { idleTtlMs: 0 })).rejects.toBeInstanceOf(RangeError);
        await expect(store.load(testScope(), { absoluteTtlMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);
      });
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
    const sealed = sealEntry(ring, a, 'g1', entry(CANARY.email, 'lena@example.invalid'));
    expect(sealed.sealed).not.toContain(CANARY.email);
    expect(openEntry(ring, a, 'g1', sealed).original).toBe(CANARY.email);
    expect(() => openEntry(ring, b, 'g1', sealed)).toThrow(expect.objectContaining({ code: 'privacy_key_unavailable' }));
    expect(() => openEntry(ring, a, 'g2', sealed)).toThrow(expect.objectContaining({ code: 'privacy_key_unavailable' }));
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

  it('a row from before per-turn lifetimes caps from its creation time', async () => {
    const c = clock();
    const store = pg({ idleTtlMs: 60_000, absoluteTtlMs: 100_000, now: c.now });
    const scope = testScope();
    const g = (await store.load(scope)).generation;
    await client.unsafe('UPDATE glirastes_privacy_mapping_scopes SET generation_started_at = NULL WHERE scope_key = $1', [scopeKeyOf(scope)]);
    c.advance(5_000);
    expect((await store.load(scope, { absoluteTtlMs: 20_000 })).generation).toBe(g);
    c.advance(15_001);
    expect((await store.load(scope, { absoluteTtlMs: 20_000 })).origin).toBe('renewed');
  });

  it('stores no plaintext originals or pseudonyms', async () => {
    const store = pg();
    const scope = testScope();
    const g = (await store.load(scope)).generation;
    await store.append(scope, g, [entry(CANARY.email, 'lena.unique@example.invalid')]);
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

  it('concurrent appends never store an original that equals another entry\'s pseudonym', async () => {
    for (let round = 0; round < 40; round += 1) {
      const scope = testScope({ conversationId: `cross-${randomBytes(6).toString('hex')}` });
      const g = (await pg().load(scope)).generation;
      // Writer A maps X → P while writer B maps P → Q: only one may win.
      await Promise.allSettled([
        pg().append(scope, g, [entry('x@example.invalid', 'p@example.invalid')]),
        pg().append(scope, g, [entry('p@example.invalid', 'q@example.invalid')]),
      ]);
      const { entries } = await pg().load(scope);
      const originals = new Set(entries.map((e) => e.original));
      expect(entries.filter((e) => originals.has(e.pseudonym))).toEqual([]);
    }
  });

  it('a delete racing appends leaves no entry of the scope behind', async () => {
    for (let round = 0; round < 20; round += 1) {
      const scope = testScope({ conversationId: `del-${randomBytes(6).toString('hex')}` });
      const g = (await pg().load(scope)).generation;
      await Promise.allSettled([
        ...Array.from({ length: 6 }, (_, i) => pg().append(scope, g, [entry(`d${i}@example.invalid`, `pd${i}@example.invalid`)])),
        pg().delete(scope),
        ...Array.from({ length: 6 }, (_, i) => pg().append(scope, g, [entry(`e${i}@example.invalid`, `pe${i}@example.invalid`)])),
      ]);
      const left = await client.unsafe<{ n: string }>(
        'SELECT count(*) AS n FROM glirastes_privacy_mapping_entries WHERE scope_key = $1',
        [scopeKeyOf(scope)],
      );
      expect(Number(left[0]!.n)).toBe(0);
      await expect(pg().load(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    }
  });

  it('a delete between reading the header and the entries is seen as deleted, not as an empty mapping', async () => {
    const scope = testScope({ conversationId: `load-race-${randomBytes(6).toString('hex')}` });
    const g = (await pg().load(scope)).generation;
    await pg().append(scope, g, [entry(CANARY.email, 'p-race@example.invalid')]);
    let deleted = false;
    const racing: PostgresQueryClient = {
      unsafe: async (sql, params) => {
        if (!deleted && sql.includes('glirastes:privacy-mapping-entries')) {
          deleted = true;
          await pg().delete(scope);
        }
        return client.unsafe(sql, params);
      },
    };
    await expect(createPostgresPrivacyMappingStore(racing, { keyring: ring }).load(scope))
      .rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
    expect(deleted).toBe(true);
  });

  it('bindings hold keyed digests only', async () => {
    const store = pg();
    const scope = testScope();
    const g = (await store.load(scope)).generation;
    await store.bind(scope, g, [store.bindingDigest(scope, g, JSON.stringify(['text', `Hallo ${CANARY.name}`]))]);
    const rows = await client.unsafe<Record<string, unknown>>(
      'SELECT * FROM glirastes_privacy_mapping_bindings WHERE scope_key = $1',
      [scopeKeyOf(scope)],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(CANARY_PATTERN);
    // Another keyring cannot reproduce the digest.
    expect(pg({}, testKeyring()).bindingDigest(scope, g, JSON.stringify(['text', `Hallo ${CANARY.name}`]))).not.toBe(rows[0]!.digest);
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
    const g = (await store.load(scope)).generation;
    await store.append(scope, g, [entry('rot@example.invalid', 'p-rot@example.invalid')]);
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
