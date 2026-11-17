import { describe, expect, it } from 'vitest';
import { extractIdentitiesFromJson, nameVariants, planName } from '../known-identities.js';
import { formatPreservingId } from '../pseudonyms.js';
import { CANARY, CANARY_PATTERN, memoryShield, testScope } from './privacy-fixtures.js';

describe('name planning', () => {
  it('splits a display name into first and last parts and skips short tokens', () => {
    expect(planName('Anna Maria de Muster')).toEqual({
      full: 'Anna Maria de Muster',
      parts: [
        { token: 'Anna', role: 'first' },
        { token: 'Maria', role: 'first' },
        { token: 'Muster', role: 'last' },
      ],
    });
    expect(nameVariants('Anna Muster')).toEqual(['Anna Muster', 'Muster, Anna']);
  });
});

describe('format-preserving ids', () => {
  it('keeps UUID, digit and letter shape', () => {
    expect(formatPreservingId(CANARY.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(formatPreservingId('u-4711')).toMatch(/^[a-z]-\d{4}$/);
    expect(formatPreservingId('12345')).toMatch(/^[1-9]\d{4}$/);
  });
});

describe('identity extraction from tool results', () => {
  it('finds people by e-mail or by a name next to a person id, and related name/id pairs', () => {
    const found = extractIdentitiesFromJson({
      users: [{ userId: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail }],
      task: { title: 'Angebot Muster GmbH', assigneeName: CANARY.name, assigneeId: CANARY.userId },
      team: { id: 'team-1', name: 'Vertrieb', ownerId: 'u-1' },
    });
    expect(found).toEqual(expect.arrayContaining([
      { email: CANARY.colleagueEmail, name: CANARY.colleague, id: CANARY.colleagueId },
      { name: CANARY.name, id: CANARY.userId },
    ]));
    // A team name next to an owner id is not a person; a task title stays free text.
    expect(found.some((i) => i.name === 'Vertrieb')).toBe(false);
    expect(found.some((i) => i.name?.includes('GmbH'))).toBe(false);
  });

  it('stops at the limit and survives cycles', () => {
    const cyclic: Record<string, unknown> = { email: 'a@example.invalid' };
    cyclic.self = cyclic;
    expect(extractIdentitiesFromJson(cyclic)).toHaveLength(1);
    const many = Array.from({ length: 50 }, (_, i) => ({ email: `p${i}@example.invalid` }));
    expect(extractIdentitiesFromJson(many, 10)).toHaveLength(10);
  });
});

describe('registered identities are protected deterministically', () => {
  async function session() {
    const s = await memoryShield().open(testScope());
    await s.registerIdentities([{ id: CANARY.userId, name: CANARY.name, email: CANARY.email }]);
    return s;
  }

  it('masks the full name, "Last, First", parts, e-mail and id; rehydrates all of them', async () => {
    const s = await session();
    const text = `${CANARY.name} (${CANARY.userId}) – auch "Muster, Anna", kurz Anna, Mail ${CANARY.email}. MUSTER bestätigt.`;
    const masked = await s.pseudonymizeText(text);
    expect(masked).not.toMatch(CANARY_PATTERN);
    expect(masked).not.toMatch(/\bAnna\b|MUSTER/i);
    expect(s.rehydrateText(masked)).toBe(text.replace('MUSTER', 'Muster'));
  });

  it('the fake full name is built from the fake parts, so model text stays consistent', async () => {
    const s = await session();
    const full = await s.pseudonymizeText(CANARY.name);
    const first = await s.pseudonymizeText(CANARY.firstName);
    const last = await s.pseudonymizeText(CANARY.lastName);
    expect(full).toBe(`${first} ${last}`);
    expect(await s.pseudonymizeText('Muster, Anna')).toBe(`${last}, ${first}`);
    expect(await s.pseudonymizeText(CANARY.email)).toMatch(/@example\.(invalid|com|org|net)$|@/);
  });

  it('pseudonymizes the same value identically across calls and in JSON keys, values and numeric ids', async () => {
    const s = await memoryShield().open(testScope());
    await s.registerIdentities([{ id: 4711, name: CANARY.colleague }]);
    const json = await s.pseudonymizeJson({ [CANARY.colleague]: { id: 4711, label: CANARY.colleague } });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toMatch(CANARY_PATTERN);
    expect(serialized).not.toContain('4711');
    const [key] = Object.keys(json);
    expect((json as Record<string, { label: string; id: number }>)[key!]!.label).toBe(key);
    expect(typeof (json as Record<string, { id: number }>)[key!]!.id).toBe('number');
    expect(s.rehydrateJson(json)).toEqual({ [CANARY.colleague]: { id: 4711, label: CANARY.colleague } });
  });

  it('short lowercase name parts are not matched case-insensitively (documented residual risk)', async () => {
    const s = await memoryShield().open(testScope());
    await s.registerIdentities([{ name: 'Tom Ott' }]);
    // "Tom" (3 letters) is exact-case only, so the word "tom" stays.
    expect(await s.pseudonymizeText('tom')).toBe('tom');
    expect(await s.pseudonymizeText('Tom')).not.toBe('Tom');
  });

  it('a known original equal to an existing pseudonym fails closed', async () => {
    const s = await memoryShield().open(testScope());
    await s.registerIdentities([{ name: CANARY.name }]);
    const fake = await s.pseudonymizeText(CANARY.name);
    await expect(s.registerIdentities([{ name: fake }])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
  });

  it('another principal cannot rehydrate this scope\'s pseudonyms', async () => {
    const shield = memoryShield();
    const scope = testScope();
    const mine = await shield.open(scope);
    await mine.registerIdentities([{ name: CANARY.name, email: CANARY.email }]);
    const masked = await mine.pseudonymizeText(`${CANARY.name} ${CANARY.email}`);
    const theirs = await shield.open({ ...scope, principalId: 'principal-2' });
    expect(theirs.rehydrateText(masked)).toBe(masked);
    const otherConversation = await shield.open({ ...scope, conversationId: 'conv-x' });
    expect(otherConversation.rehydrateText(masked)).toBe(masked);
  });

  it('counts leaks of full values but not of single name parts', async () => {
    const s = await session();
    expect(s.countLeaks(`Hallo ${CANARY.name}`)).toBe(1);
    expect(s.countLeaks(`Hallo ${CANARY.email}`)).toBe(1);
    expect(s.countLeaks('Hallo Anna')).toBe(0);
  });
});
