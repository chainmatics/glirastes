import { randomInt } from 'node:crypto';

/**
 * Date handling of the protected-text profile. A date alone is not personal
 * data: appointments and deadlines go to the model unchanged. Only a date of
 * birth, recognised by its context (a field name or a word such as
 * "geboren"), is replaced. Its pseudonym is one fake date, written in
 * whatever format the original or the model used, and mapped back by value.
 */

export type DateFormat = 'dotted' | 'dotted-short' | 'iso' | 'text-de' | 'text-en';

export interface ParsedDate {
  /** yyyy-mm-dd */
  iso: string;
  format: DateFormat;
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_NAMES = [...MONTHS_DE, ...MONTHS_EN.filter((m) => !MONTHS_DE.includes(m))];

/** Dates the profile can read and write, anywhere in a text. */
export const DATE_TOKEN = new RegExp(
  // An ISO date may continue as a timestamp ("1980-01-15T00:00:00Z").
  `(?<![\\p{L}\\p{N}])(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4}(?![\\p{L}\\p{N}])|\\d{4}-\\d{2}-\\d{2}(?=T\\d|(?![\\p{L}\\p{N}]))|\\d{1,2}\\.?\\s+(?:${MONTH_NAMES.join('|')})\\s+\\d{4}(?![\\p{L}\\p{N}]))`,
  'giu',
);

/** Words that make a following date a date of birth. */
const BIRTH_CONTEXT = '(?:geb\\.|geboren(?:\\s+am)?|geburtsdatum|geburtstag|geb\\.-datum|dob|d\\.o\\.b\\.|date\\s+of\\s+birth|birth\\s*date|birthday|born(?:\\s+on)?)';
/** Up to three words between the context and the date ("Geburtsdatum des Kunden:", "geb.-Dat.:", "geboren am Montag,"). */
const BIRTH_FILLER = '(?:[\\s-]+[\\p{L}][\\p{L}.]*,?){0,3}';
const BIRTH_LEAD = `(?<![\\p{L}\\p{N}])${BIRTH_CONTEXT}${BIRTH_FILLER}\\s*:?\\s*`;
const READABLE_DATE = `(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.?\\s+(?:${MONTH_NAMES.join('|')})\\s+\\d{4})(?![\\p{L}\\p{N}])`;
export const BIRTH_DATE_IN_TEXT = new RegExp(`(?<=${BIRTH_LEAD})${READABLE_DATE}`, 'giu');

const MONTH_WORD = `(?:${[...MONTH_NAMES, ...MONTH_NAMES.map((m) => m.slice(0, 3)), 'Sept', 'Mrz'].join('|')})\\.?`;
/**
 * Anything after a birth context that looks like a date: numbers with
 * separators (also "15.01.80" or "01/15/1980") or a month word with numbers.
 * When it is not a date this module can read, the text is refused instead of
 * sending a date of birth unprotected.
 */
export const BIRTH_DATE_LIKE = new RegExp(
  `(?<=${BIRTH_LEAD})(?:\\d{1,4}\\s*[./-]\\s*\\d{1,2}\\s*[./-]\\s*\\d{2,4}|\\d{1,2}\\.?\\s+${MONTH_WORD}\\s+\\d{2,4}|${MONTH_WORD}\\s+\\d{1,2},?\\s+\\d{2,4})(?![\\p{N}])`,
  'giu',
);

/**
 * JSON keys whose value is a date of birth, also inside longer names
 * (`patientBirthDate`, `birth_date_iso`, `geburtsdatum_patient`).
 */
const BIRTH_KEY_WORDS = /(?:^|_)(?:birth_?date|date_?of_?birth|dob|birth_?day|geburtsdatum|geburtstag|geb_?datum)(?:_|$)/;
export const BIRTH_DATE_KEY = {
  test(key: string): boolean {
    const words = key.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_');
    return BIRTH_KEY_WORDS.test(words);
  },
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Reads one date token. `null` for anything else (including impossible dates). */
export function parseDate(text: string): ParsedDate | null {
  const value = text.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (m) {
    const iso = validIso(Number(m[3]), Number(m[2]), Number(m[1]));
    return iso ? { iso, format: m[1]!.length === 2 && m[2]!.length === 2 ? 'dotted' : 'dotted-short' } : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const iso = validIso(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { iso, format: 'iso' } : null;
  }
  m = /^(\d{1,2})\.?\s+(\p{L}+)\s+(\d{4})$/u.exec(value);
  if (m) {
    const name = m[2]!.toLowerCase();
    const de = MONTHS_DE.findIndex((month) => month.toLowerCase() === name);
    const en = MONTHS_EN.findIndex((month) => month.toLowerCase() === name);
    const index = de >= 0 ? de : en;
    if (index < 0) return null;
    const iso = validIso(Number(m[3]), index + 1, Number(m[1]));
    return iso ? { iso, format: de >= 0 ? 'text-de' : 'text-en' } : null;
  }
  return null;
}

export function formatDate(iso: string, format: DateFormat): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  switch (format) {
    case 'dotted':
      return `${pad(day)}.${pad(month)}.${year}`;
    case 'dotted-short':
      return `${day}.${month}.${year}`;
    case 'iso':
      return iso;
    case 'text-de':
      return `${day}. ${MONTHS_DE[month - 1]} ${year}`;
    case 'text-en':
      return `${day} ${MONTHS_EN[month - 1]} ${year}`;
  }
}

/** A fake date of birth between 1950 and 2005 in another year than `avoid`. */
export function fakeBirthDate(avoid?: string): string {
  for (;;) {
    const iso = validIso(randomInt(1950, 2006), randomInt(1, 13), randomInt(1, 29))!;
    if (iso.slice(0, 4) !== avoid?.slice(0, 4)) return iso;
  }
}

/**
 * True when `text` mentions the date `iso` in a form this module cannot
 * read (for example "12/12/1976" or "Dec 12, 1976"): the year together with
 * its day and month nearby. Used to refuse a tool input whose fake date
 * could not be mapped back.
 */
export function mentionsDateLoosely(text: string, iso: string): boolean {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const yearPattern = new RegExp(`(?<!\\d)${year}(?!\\d)`, 'g');
  const monthNames = [MONTHS_DE[month - 1]!, MONTHS_EN[month - 1]!].map((name) => name.slice(0, 3).toLowerCase());
  for (const match of text.matchAll(yearPattern)) {
    const window = (text.slice(Math.max(0, match.index! - 16), match.index!) + ' ' + text.slice(match.index! + 4, match.index! + 20)).toLowerCase();
    const numbers = [...window.matchAll(/(?<!\d)\d{1,2}(?!\d)/g)].map((m) => Number(m[0]));
    const hasDay = numbers.includes(day);
    const hasMonth = monthNames.some((name) => window.includes(name))
      || (day === month ? numbers.filter((n) => n === day).length >= 2 : numbers.includes(month));
    if (hasDay && hasMonth) return true;
  }
  return false;
}
