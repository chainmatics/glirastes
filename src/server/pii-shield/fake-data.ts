import type { PiiCategory } from '../../types.js';

// ---------------------------------------------------------------------------
// xorshift32 PRNG — deterministic, seedable
// ---------------------------------------------------------------------------

function createPrng(seed: number) {
  let state = seed | 0 || 1; // must not be 0
  return {
    next(): number {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      return (state >>> 0) / 0xffffffff; // [0, 1)
    },
  };
}

// ---------------------------------------------------------------------------
// Name pools
// ---------------------------------------------------------------------------

const DE_FIRST = ['Lukas', 'Anna', 'Felix', 'Marie', 'Jonas', 'Lena', 'Maximilian', 'Sophie', 'Tobias', 'Katharina'];
const DE_LAST = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Schulz'];

const EN_FIRST = ['James', 'Emily', 'Robert', 'Sarah', 'William', 'Jessica', 'Michael', 'Ashley', 'David', 'Jennifer'];
const EN_LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor'];

// ---------------------------------------------------------------------------
// Address pools
// ---------------------------------------------------------------------------

const DE_STREETS = ['Berliner Str.', 'Hauptstr.', 'Bahnhofstr.', 'Gartenstr.', 'Schillerstr.', 'Goethestr.', 'Mozartstr.', 'Lindenstr.', 'Rosenweg', 'Waldstr.'];
const DE_CITIES = ['Berlin', 'München', 'Hamburg', 'Köln', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig', 'Dresden', 'Hannover'];

const EN_STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Elm St', 'Pine Rd', 'Birch Way', 'Park Blvd', 'Lake Dr', 'Hill Rd'];
const EN_CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin'];

// ---------------------------------------------------------------------------
// Email domains
// ---------------------------------------------------------------------------

const EMAIL_DOMAINS = ['example.com', 'mail.test', 'demo.org', 'sample.net', 'test.de'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transliterateDE(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => {
      const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
      return map[c] ?? c;
    });
}

// ---------------------------------------------------------------------------
// Generator factory
// ---------------------------------------------------------------------------

export interface FakeDataGenerator {
  generate(category: PiiCategory | string): string;
}

export function createFakeDataGenerator(seed: number, locale: string): FakeDataGenerator {
  const prng = createPrng(seed);

  const pick = <T>(arr: T[]): T => arr[Math.floor(prng.next() * arr.length)]!;
  const randInt = (min: number, max: number): number => min + Math.floor(prng.next() * (max - min + 1));
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

  const isDE = locale.startsWith('de');

  const firstPool = isDE ? DE_FIRST : EN_FIRST;
  const lastPool = isDE ? DE_LAST : EN_LAST;

  // Track last generated person for coherent email
  let lastFirst = '';
  let lastLast = '';

  const generators: Record<string, () => string> = {
    person() {
      lastFirst = pick(firstPool);
      lastLast = pick(lastPool);
      return `${lastFirst} ${lastLast}`;
    },

    email() {
      const first = lastFirst || pick(firstPool);
      const last = lastLast || pick(lastPool);
      const domain = pick(EMAIL_DOMAINS);
      const f = transliterateDE(first);
      const l = transliterateDE(last);
      return `${f}.${l}@${domain}`;
    },

    phone() {
      if (isDE) {
        const area = randInt(30, 89);
        const num = randInt(1000000, 9999999);
        return `+49 ${area} ${num}`;
      }
      const area = randInt(200, 999);
      const prefix = randInt(200, 999);
      const line = randInt(1000, 9999);
      return `+1 (${area}) ${prefix}-${line}`;
    },

    iban() {
      if (isDE) {
        const check = pad(randInt(10, 99));
        const bankCode = pad(randInt(1000, 9999), 4);
        const bankCode2 = pad(randInt(1000, 9999), 4);
        const acct1 = pad(randInt(1000, 9999), 4);
        const acct2 = pad(randInt(1000, 9999), 4);
        const acct3 = pad(randInt(10, 99));
        return `DE${check} ${bankCode} ${bankCode2} ${acct1} ${acct2} ${acct3}`;
      }
      // GB fallback
      const check = pad(randInt(10, 99));
      const sort = pad(randInt(100000, 999999), 6);
      const acct = pad(randInt(10000000, 99999999), 8);
      return `GB${check} ${sort} ${acct}`;
    },

    credit_card() {
      const last4 = pad(randInt(1000, 9999), 4);
      return `XXXX-XXXX-XXXX-${last4}`;
    },

    ip_address() {
      return `10.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
    },

    date_of_birth() {
      const year = randInt(1950, 2005);
      const month = randInt(1, 12);
      const day = randInt(1, 28);
      if (isDE) {
        return `${pad(day)}.${pad(month)}.${year}`;
      }
      return `${pad(month)}/${pad(day)}/${year}`;
    },

    address() {
      const streets = isDE ? DE_STREETS : EN_STREETS;
      const cities = isDE ? DE_CITIES : EN_CITIES;
      const street = pick(streets);
      const num = randInt(1, 200);
      const city = pick(cities);
      if (isDE) {
        const zip = pad(randInt(10000, 99999), 5);
        return `${street} ${num}, ${zip} ${city}`;
      }
      const zip = pad(randInt(10000, 99999), 5);
      const state = pick(['CA', 'TX', 'NY', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI']);
      return `${num} ${street}, ${city}, ${state} ${zip}`;
    },

    tax_id() {
      if (isDE) {
        // German Steuer-ID format: 11 digits
        const digits = Array.from({ length: 11 }, () => randInt(0, 9)).join('');
        return digits;
      }
      // US EIN format: XX-XXXXXXX
      return `${pad(randInt(10, 99))}-${pad(randInt(1000000, 9999999), 7)}`;
    },

    ssn() {
      if (isDE) {
        // German Sozialversicherungsnummer: 12 chars
        const digits = Array.from({ length: 12 }, () => randInt(0, 9)).join('');
        return digits;
      }
      // US SSN format: XXX-XX-XXXX
      return `${pad(randInt(100, 999), 3)}-${pad(randInt(10, 99))}-${pad(randInt(1000, 9999), 4)}`;
    },

    url() {
      const tld = isDE ? '.de' : '.com';
      const words = ['example', 'demo', 'test', 'sample', 'mock', 'fake', 'placeholder'];
      return `https://${pick(words)}${tld}/${randInt(1000, 9999)}`;
    },

    cvv() {
      return pad(randInt(100, 999), 3);
    },

    card_expiry() {
      const month = pad(randInt(1, 12));
      const year = randInt(26, 32);
      return `${month}/${year}`;
    },
  };

  return {
    generate(category: PiiCategory | string): string {
      const gen = generators[category];
      if (gen) return gen();
      // Unknown / custom category: fallback
      return `[REDACTED_${pad(randInt(1000, 9999), 4)}]`;
    },
  };
}
