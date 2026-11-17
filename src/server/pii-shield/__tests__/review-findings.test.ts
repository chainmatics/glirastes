/**
 * Regression tests for the final review of the protected-text profile
 * (findings R1–R5, R10 of the shield; numbering of the review report).
 * Each test names the finding it pins.
 */
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { extractIdentities } from '../known-identities.js';
import { createMemoryPrivacyMappingStore } from '../mapping-store.js';
import { createPrivacyBoundary } from '../model-boundary.js';
import { memoryShield, testScope } from './privacy-fixtures.js';

async function transform(boundary: ReturnType<typeof createPrivacyBoundary>, prompt: unknown, extra: Partial<LanguageModelV3CallOptions> = {}) {
  return boundary.middleware.transformParams!({
    type: 'generate',
    model: {} as never,
    params: { prompt: prompt as LanguageModelV3Prompt, ...extra },
  });
}

describe('R2: people in tool results', () => {
  it('protects { id, firstName, lastName, email } by name parts and full name', async () => {
    const session = await memoryShield().open(testScope());
    const boundary = createPrivacyBoundary({ session });
    const out = await transform(boundary, [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'getContact', output: { type: 'json', value: { id: 'c_123', firstName: 'Hildegard', lastName: 'Schwarzenegger', email: 'h.s@kunde.example' } } }] },
      { role: 'user', content: [{ type: 'text', text: 'Ruf Hildegard Schwarzenegger an, sag Schwarzenegger Bescheid' }] },
    ]);
    expect(JSON.stringify(out.prompt)).not.toMatch(/Hildegard|Schwarzenegger|c_123|h\.s@kunde/);
  });

  it('protects { id, name } below a people key or with a person kind', async () => {
    expect(extractIdentities({ members: [{ id: 'u_9', name: 'Kunigunde Wackernagel', role: 'admin' }] }).identities)
      .toEqual([{ id: 'u_9', name: 'Kunigunde Wackernagel' }]);
    expect(extractIdentities({ items: [{ id: 'u_9', name: 'Kunigunde Wackernagel', type: 'user' }] }).identities)
      .toEqual([{ id: 'u_9', name: 'Kunigunde Wackernagel' }]);
    expect(extractIdentities({ task: { id: 't1', title: 'X', assignee: { id: 'u_9', name: 'Kunigunde Wackernagel' } } }).identities)
      .toEqual([{ id: 'u_9', name: 'Kunigunde Wackernagel' }]);
  });

  it('counter-check: a plain { id, name } of a project, product or appointment is not a person', async () => {
    expect(extractIdentities({ id: 'p1', name: 'Projekt Alpha' }).identities).toEqual([]);
    expect(extractIdentities({ projects: [{ id: 'p1', name: 'Projekt Alpha' }], products: [{ id: 9, name: 'Shirt Klein' }] }).identities).toEqual([]);
    expect(extractIdentities({ appointments: [{ id: 'a1', name: 'Quartalsgespräch', type: 'meeting' }] }).identities).toEqual([]);
    const session = await memoryShield().open(testScope());
    const boundary = createPrivacyBoundary({ session });
    const out = await transform(boundary, [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'listProjects', output: { type: 'json', value: [{ id: 'p1', name: 'Projekt Alpha' }] } }] },
    ]);
    expect(JSON.stringify(out.prompt)).toContain('Projekt Alpha');
  });

  it('reports an incomplete extraction instead of treating a cut-off walk as complete', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@example.invalid` }));
    expect(extractIdentities(many, 10).complete).toBe(false);
    let deep: Record<string, unknown> = { email: 'deep@example.invalid' };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(extractIdentities(deep).complete).toBe(false);
    expect(extractIdentities({ users: [{ email: 'a@example.invalid' }] }).complete).toBe(true);
  });

  it('the boundary refuses a tool result whose people it could not all extract', async () => {
    const session = await memoryShield().open(testScope());
    const boundary = createPrivacyBoundary({ session });
    let deep: Record<string, unknown> = { email: 'deep@example.invalid', name: 'Tief Versteckt' };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    await expect(transform(boundary, [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'dump', output: { type: 'json', value: deep } }] },
    ])).rejects.toMatchObject({ code: 'privacy_unsupported_content' });
  });
});

describe('R1: display names in "Last, First" form and short name parts', () => {
  it('no token of the original name stays inside the pseudonym', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ id: 'contact-77', name: 'Müller, Hans', email: 'hans.mueller@firma.example' }]);
    const out = await session.pseudonymizeText('Bitte ruf Müller, Hans an (hans.mueller@firma.example). Hans Müller weiß Bescheid.');
    expect(out).not.toMatch(/Müller|Hans|mueller|muller/i);
    expect(session.rehydrateText(out)).toBe('Bitte ruf Müller, Hans an (hans.mueller@firma.example). Hans Müller weiß Bescheid.');
  });

  it('a short token ("Li") gets its own filler in the full-name pseudonym', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ name: 'Li Wei' }]);
    const out = await session.pseudonymizeText('Termin mit Li Wei');
    expect(out).not.toMatch(/\bLi\b|Wei/);
    expect(session.rehydrateText(out)).toBe('Termin mit Li Wei');
  });
});

describe('R3: a pseudonym in new raw text is a collision', () => {
  it('raw text that holds a pseudonym of the scope is refused, never sent or mapped to another person', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ id: 'contact-1', name: 'Max Mustermann', email: 'max@firma.example' }]);
    const fake = await session.pseudonymizeText('Max Mustermann');
    await expect(session.pseudonymizeText(`Schreib ${fake} eine Mail`)).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    await expect(session.pseudonymizeJson({ recipientName: fake })).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
  });

  it('model output of this turn may hold pseudonyms (server-side provenance)', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ name: 'Max Mustermann' }]);
    const fake = await session.pseudonymizeText('Max Mustermann');
    expect(await session.pseudonymizeText(`Ich schreibe ${fake}.`, { origin: 'model' })).toBe(`Ich schreibe ${fake}.`);
  });

  it('the boundary treats browser history as raw: a pseudonym there is refused', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ name: 'Max Mustermann' }]);
    const fake = await session.pseudonymizeText('Max Mustermann');
    const boundary = createPrivacyBoundary({ session });
    // An assistant text the boundary never emitted: claimed provenance does not count.
    await expect(transform(boundary, [
      { role: 'assistant', content: [{ type: 'text', text: `Erledigt für ${fake}.` }] },
      { role: 'user', content: [{ type: 'text', text: 'Danke' }] },
    ])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
    await expect(transform(boundary, [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'mail', input: { to: fake } }] },
    ])).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
  });

  it('a pseudonym of another scope or of an expired generation is neither refused nor mapped back', async () => {
    let now = Date.parse('2026-11-17T09:00:00Z');
    const store = createMemoryPrivacyMappingStore({ now: () => new Date(now) });
    const scope = testScope();
    const first = await memoryShield({ store }).open(scope);
    await first.registerIdentities([{ name: 'Max Mustermann' }]);
    const fake = await first.pseudonymizeText('Max Mustermann');
    now += 61 * 60 * 1000;
    const renewed = await memoryShield({ store }).open(scope);
    expect(renewed.origin).toBe('renewed');
    expect(renewed.rehydrateText(fake)).toBe(fake);
    const other = await memoryShield({ store }).open(testScope());
    expect(other.rehydrateText(fake)).toBe(fake);
    expect(await other.pseudonymizeText(`Hallo ${fake}`)).toBe(`Hallo ${fake}`);
  });

  it('a lifetime shortened by the policy ends the generation; its pseudonyms stay pseudonyms', async () => {
    let now = Date.parse('2026-11-17T09:00:00Z');
    const store = createMemoryPrivacyMappingStore({ now: () => new Date(now) });
    const scope = testScope();
    const first = await memoryShield({ store }).open(scope);
    await first.registerIdentities([{ name: 'Max Mustermann' }]);
    const fake = await first.pseudonymizeText('Max Mustermann');
    now += 10 * 60 * 1000;
    // Inside the store's 24 h, outside the 5 min the policy now allows.
    const renewed = await memoryShield({ store }).open(scope, { lifetime: { absoluteTtlMs: 5 * 60 * 1000 } });
    expect(renewed.origin).toBe('renewed');
    expect(renewed.rehydrateText(fake)).toBe(fake);
  });

  it('a session refuses to continue on a generation that changed under it', async () => {
    let now = Date.parse('2026-11-17T09:00:00Z');
    const store = createMemoryPrivacyMappingStore({ now: () => new Date(now) });
    const scope = testScope();
    const session = await memoryShield({ store }).open(scope);
    now += 61 * 60 * 1000;
    await memoryShield({ store }).open(scope);
    await expect(session.pseudonymizeText('Mail an neu@example.invalid')).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
  });
});

describe('R4: dates', () => {
  it('a date alone is not a date of birth and goes unchanged', async () => {
    const session = await memoryShield().open(testScope());
    expect(await session.pseudonymizeText('Lege einen Termin am 15.01.2026 an, Frist 2026-02-01')).toBe('Lege einen Termin am 15.01.2026 an, Frist 2026-02-01');
    expect(session.rehydrateToolInput({ date: '2026-01-15' })).toEqual({ date: '2026-01-15' });
  });

  it('a date of birth in free text is replaced, and every further occurrence in any format too', async () => {
    const session = await memoryShield().open(testScope());
    const first = await session.pseudonymizeText('Kundin, geboren am 15.01.1980.');
    expect(first).not.toContain('15.01.1980');
    const fakeDotted = /(\d{2}\.\d{2}\.\d{4})/.exec(first)![1]!;
    const [d, m, y] = fakeDotted.split('.');
    const later = await session.pseudonymizeText('Bitte 1980-01-15 und 15. Januar 1980 prüfen.');
    expect(later).toBe(`Bitte ${y}-${m}-${d} und ${Number(d)}. ${['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][Number(m) - 1]} ${y} prüfen.`);
  });

  it('DD.MM.YYYY and ISO round-trip: a fake date the model writes in either format reaches the tool as the original', async () => {
    const session = await memoryShield().open(testScope());
    const masked = await session.pseudonymizeJson({ birthDate: '1980-01-15', note: 'geb. 15.01.1980' }) as { birthDate: string; note: string };
    expect(masked.birthDate).not.toBe('1980-01-15');
    expect(masked.note).not.toContain('15.01.1980');
    const iso = masked.birthDate;
    const [y, m, d] = iso.split('-');
    expect(session.rehydrateToolInput({ dob: iso })).toEqual({ dob: '1980-01-15' });
    expect(session.rehydrateToolInput({ dob: `${d}.${m}.${y}` })).toEqual({ dob: '15.01.1980' });
    expect(session.rehydrateToolInput({ dob: `${iso}T00:00:00Z` })).toEqual({ dob: '1980-01-15T00:00:00Z' });
  });

  it('a fake date in a format that cannot be mapped back never reaches the tool', async () => {
    const session = await memoryShield().open(testScope());
    const masked = await session.pseudonymizeJson({ dateOfBirth: '15.01.1980' }) as { dateOfBirth: string };
    const [d, m, y] = masked.dateOfBirth.split('.');
    expect(() => session.rehydrateToolInput({ dob: `${m}/${d}/${y}` })).toThrow(expect.objectContaining({ code: 'privacy_mapping_conflict' }));
  });

  it('a birth-date field that cannot be read is refused instead of passed', async () => {
    const session = await memoryShield().open(testScope());
    await expect(session.pseudonymizeJson({ birthDate: 'Mitte Januar achtzig' })).rejects.toMatchObject({ code: 'privacy_unsupported_content' });
  });

  it('raw text that holds the fake birth date (in any format) is a collision', async () => {
    const session = await memoryShield().open(testScope());
    const masked = await session.pseudonymizeJson({ birthDate: '15.01.1980' }) as { birthDate: string };
    const [d, m, y] = masked.birthDate.split('.');
    await expect(session.pseudonymizeText(`Termin am ${y}-${m}-${d}`)).rejects.toMatchObject({ code: 'privacy_mapping_conflict' });
  });

  it('a phone number pseudonym the model reformats maps back to the original', async () => {
    const session = await memoryShield().open(testScope());
    const masked = await session.pseudonymizeText('Ruf +49 30 1234567 an');
    const fake = /(\+49[\d\s]+\d)/.exec(masked)![1]!;
    const compact = fake.replace(/\s/g, '');
    expect(session.rehydrateToolInput({ phone: compact })).toEqual({ phone: '+49 30 1234567' });
  });
});

describe('R5: name parts only match when written like a name', () => {
  it('the family name Klein masks "Klein" and "KLEIN", not the word "klein"; tools with the enum stay', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ id: 'u-100', name: 'Maria Klein', email: 'maria@firma.example' }]);
    const out = await session.pseudonymizeText('Frau Klein will es klein. KLEIN bestätigt.');
    expect(out).not.toMatch(/Klein|KLEIN/);
    expect(out).toContain('will es klein.');
    const blocked: string[] = [];
    const boundary = createPrivacyBoundary({ session, onBlocked: (code) => blocked.push(code) });
    const res = await transform(boundary, [{ role: 'user', content: [{ type: 'text', text: 'Bestelle die kleine Größe' }] }], {
      tools: [{ type: 'function', name: 'order', description: 'Bestellt ein Shirt in klein oder groß', inputSchema: { type: 'object', properties: { size: { type: 'string', enum: ['klein', 'groß'] } } } }],
    });
    expect(res.tools).toHaveLength(1);
    expect((res.tools![0] as { description?: string }).description).toBe('Bestellt ein Shirt in klein oder groß');
    expect(blocked).toEqual([]);
  });
});

describe('R6: provider references in history', () => {
  it('drops OpenAI item ids and encrypted reasoning from history parts; other unknown options still stop', async () => {
    const session = await memoryShield().open(testScope());
    const boundary = createPrivacyBoundary({ session });
    const out = await transform(boundary, [
      { role: 'user', content: [{ type: 'text', text: 'Hallo' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'kurz', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'opaque-blob' } } },
          { type: 'text', text: 'Hi', providerOptions: { openai: { itemId: 'msg_1' } } },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: {}, providerOptions: { openai: { itemId: 'fc_1' } } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: { type: 'json', value: {} }, providerOptions: { openai: { itemId: 'fco_1' } } }] },
      { role: 'user', content: [{ type: 'text', text: 'Weiter' }] },
    ]);
    const serialized = JSON.stringify(out.prompt);
    expect(serialized).not.toMatch(/itemId|opaque-blob|reasoningEncryptedContent/);
    expect(serialized).toContain('"text":"Hi"');

    await expect(transform(boundary, [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'kurz', providerOptions: { anthropic: { signature: 'sig' } } }] },
      { role: 'user', content: [{ type: 'text', text: 'Weiter' }] },
    ])).rejects.toMatchObject({ code: 'privacy_provider_option_blocked' });
  });
});

describe('M5 (independent re-review): birth dates around the context word', () => {
  it.each([
    ['Geburtsdatum des Kunden: 01.01.1980', '01.01.1980'],
    ['geb.-Dat.: 2.3.1981', '2.3.1981'],
    ['geboren am Montag, 5.3.1980', '5.3.1980'],
  ])('protects %s', async (text, date) => {
    const session = await memoryShield().open(testScope());
    const out = await session.pseudonymizeText(text);
    expect(out).not.toContain(date);
    expect(session.rehydrateText(out)).toBe(text);
  });

  it.each(['geb. 15.01.80', 'DOB 01/15/1980', 'born on Dec 12, 1976', 'Geburtsdatum: 12 Dez 1976'])(
    'refuses a birth date it cannot map back: %s',
    async (text) => {
      const session = await memoryShield().open(testScope());
      await expect(session.pseudonymizeText(text)).rejects.toMatchObject({ code: 'privacy_unsupported_content' });
    },
  );

  it('leaves appointments as plain text', async () => {
    const session = await memoryShield().open(testScope());
    expect(await session.pseudonymizeText('Termin am 12.05.2026 und am 3/5/2026')).toBe('Termin am 12.05.2026 und am 3/5/2026');
  });

  it.each(['patientBirthDate', 'birth_date_iso', 'geburtsdatum_patient', 'dateOfBirth'])('treats the field %s as a date of birth', async (key) => {
    const session = await memoryShield().open(testScope());
    const out = await session.pseudonymizeJson({ [key]: '1980-01-15' }) as Record<string, string>;
    expect(Object.values(out)[0]).not.toBe('1980-01-15');
  });

  it('does not take updatedAt or adobeId for a birth field', async () => {
    const session = await memoryShield().open(testScope());
    expect(await session.pseudonymizeJson({ updatedAt: '2026-01-15', adobeId: '1980-01-15' })).toEqual({ updatedAt: '2026-01-15', adobeId: '1980-01-15' });
  });
});
