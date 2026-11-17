import { randomInt, randomUUID } from 'node:crypto';
import { createFakeDataGenerator } from './fake-data.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();

/**
 * A replacement with the same character classes and length, so a pseudonym
 * of an id still passes a tool schema's format or pattern. UUIDs become
 * random v4 UUIDs; digits stay digits (no leading zero), letters stay letters.
 */
export function formatPreservingId(original: string): string {
  if (UUID.test(original)) {
    const fresh = randomUUID();
    return original === original.toUpperCase() ? fresh.toUpperCase() : fresh;
  }
  let out = '';
  for (let i = 0; i < original.length; i++) {
    const ch = original[i]!;
    if (ch >= '0' && ch <= '9') out += String(i === 0 && /^\d+$/.test(original) ? randomInt(1, 10) : randomInt(0, 10));
    else if (ch >= 'a' && ch <= 'z') out += LOWER[randomInt(0, 26)];
    else if (ch >= 'A' && ch <= 'Z') out += UPPER[randomInt(0, 26)];
    else out += ch;
  }
  return out;
}

function seed(): number {
  return randomInt(1, 2 ** 31 - 1);
}

const FIRST_DE = ['Lena', 'Jonas', 'Mia', 'Felix', 'Clara', 'Paul', 'Emma', 'Lukas', 'Hanna', 'Tim', 'Sophie', 'Ben', 'Lea', 'Noah', 'Ida', 'Jan', 'Marie', 'Tom', 'Greta', 'Erik'];
const LAST_DE = ['Albers', 'Brandt', 'Conrad', 'Dietz', 'Engel', 'Fuchs', 'Graf', 'Hahn', 'Ilg', 'Jung', 'Kraus', 'Lorenz', 'Mertens', 'Nolte', 'Ott', 'Pohl', 'Roth', 'Seidel', 'Thiel', 'Vogt'];
const FIRST_EN = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Jamie', 'Avery', 'Quinn'];
const LAST_EN = ['Archer', 'Baker', 'Carter', 'Dawson', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Irving', 'Keller'];

function pick<T>(list: readonly T[]): T {
  return list[randomInt(0, list.length)]!;
}

function translit(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/ß/g, 'ss')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
}

/** Category → fresh candidate pseudonym. Uniqueness is enforced by the store. */
export function generatePseudonym(category: string, original: string, locale: string, attempt = 0): string {
  const de = locale.toLowerCase().startsWith('de');
  const suffix = attempt > 4 ? String(randomInt(2, 99)) : '';
  switch (category) {
    case 'name-first':
      return pick(de ? FIRST_DE : FIRST_EN) + suffix;
    case 'name-last':
      return pick(de ? LAST_DE : LAST_EN) + suffix;
    case 'person':
      return `${pick(de ? FIRST_DE : FIRST_EN)} ${pick(de ? LAST_DE : LAST_EN)}${suffix}`;
    case 'email':
      return `${translit(pick(de ? FIRST_DE : FIRST_EN))}.${translit(pick(de ? LAST_DE : LAST_EN))}${randomInt(1, 999)}@example.org`;
    case 'identity-id':
      return formatPreservingId(original);
    case 'url':
      return `https://example.invalid/r/${randomUUID().slice(0, 8)}`;
    case 'phone':
    case 'iban':
    case 'credit_card':
    case 'ip_address':
    case 'date_of_birth':
    case 'address':
    case 'tax_id':
    case 'ssn':
      return createFakeDataGenerator(seed(), locale).generate(category) + (suffix ? ` ${suffix}` : '');
    default:
      return `[${category.replace(/[^a-z_-]/gi, '').slice(0, 24) || 'value'}-${randomUUID().slice(0, 6)}]`;
  }
}

export function emailFromName(first: string, last: string): string {
  return `${translit(first)}.${translit(last)}@example.org`;
}
