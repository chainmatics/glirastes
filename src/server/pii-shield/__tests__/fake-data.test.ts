import { describe, it, expect } from 'vitest';
import { createFakeDataGenerator } from '../fake-data.js';

describe('FakeDataGenerator', () => {
  it('generates deterministic pseudonyms for same seed', () => {
    const gen1 = createFakeDataGenerator(42, 'de');
    const gen2 = createFakeDataGenerator(42, 'de');
    expect(gen1.generate('person')).toBe(gen2.generate('person'));
  });

  it('generates different pseudonyms for different seeds', () => {
    const gen1 = createFakeDataGenerator(42, 'de');
    const gen2 = createFakeDataGenerator(99, 'de');
    expect(gen1.generate('person')).not.toBe(gen2.generate('person'));
  });

  it('generates DE person names', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const name = gen.generate('person');
    expect(name).toMatch(/^\S+ \S+$/);
  });

  it('generates EN person names', () => {
    const gen = createFakeDataGenerator(42, 'en');
    const name = gen.generate('person');
    expect(name).toMatch(/^\S+ \S+$/);
  });

  it('generates email matching person pseudonym', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const person = gen.generate('person');
    const email = gen.generate('email');
    const [first] = person.toLowerCase().replace(/[äöüß]/g, (c) => {
      const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
      return map[c] ?? c;
    }).split(' ');
    expect(email).toContain(first);
  });

  it('generates valid DE phone number', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const phone = gen.generate('phone');
    expect(phone).toMatch(/^\+49/);
  });

  it('generates valid DE IBAN', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const iban = gen.generate('iban');
    expect(iban).toMatch(/^DE\d{2} \d{4} \d{4} \d{4} \d{4} \d{2}$/);
  });

  it('generates masked credit card', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const cc = gen.generate('credit_card');
    expect(cc).toMatch(/^XXXX-XXXX-XXXX-\d{4}$/);
  });

  it('generates private IP address', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const ip = gen.generate('ip_address');
    expect(ip).toMatch(/^10\.\d+\.\d+\.\d+$/);
  });

  it('generates DE date of birth', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const dob = gen.generate('date_of_birth');
    expect(dob).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it('generates EN date of birth', () => {
    const gen = createFakeDataGenerator(42, 'en');
    const dob = gen.generate('date_of_birth');
    expect(dob).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('returns unique pseudonyms for sequential calls of same type', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      names.add(gen.generate('person'));
    }
    expect(names.size).toBeGreaterThan(1);
  });

  it('handles unknown category with fallback', () => {
    const gen = createFakeDataGenerator(42, 'de');
    const result = gen.generate('custom');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
