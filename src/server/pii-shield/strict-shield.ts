import type { PiiDetector, PiiEntity } from '../../types.js';
import { BIRTH_DATE_KEY, BIRTH_DATE_LIKE, DATE_TOKEN, formatDate, mentionsDateLoosely, parseDate } from './dates.js';
import { detectOrThrow, isRemoteDetector, PrivacyError } from './detection-result.js';
import {
  identityIdString,
  nameVariants,
  planName,
  type KnownIdentity,
} from './known-identities.js';
import {
  assertPrivacyScope,
  normalizeMappingValue,
  type MappingEntry,
  type MappingOrigin,
  type MappingSnapshot,
  type PrivacyMappingStore,
  type PrivacyScope,
} from './mapping-store.js';
import { emailFromName, fillerFirstName, generatePseudonym } from './pseudonyms.js';
import { createRegexPiiDetector } from './regex-detector.js';

/** Version of the protected-text contract this shield implements. */
export const PROTECTED_TEXT_PROFILE = 'protected-text/v1' as const;

/** Content-free audit record: counts and categories only. */
export interface PrivacyAuditEvent {
  type: 'pseudonymized' | 'rehydrated' | 'identities-registered' | 'blocked';
  scope: { tenantId: string; principalId: string };
  categories: Record<string, number>;
  code?: string;
}

export interface StrictPiiShieldConfig {
  /** Persistent scoped mapping; the in-memory store is refused unless `allowEphemeralStore`. */
  store: PrivacyMappingStore;
  /** Local detectors. Default: the regex detector. Remote detectors are refused. */
  detectors?: PiiDetector[];
  locale: string;
  /** Deadline per detector call. Default 2000 ms. */
  detectorDeadlineMs?: number;
  /** Tests only: accept a non-persistent store. */
  allowEphemeralStore?: boolean;
  onAudit?: (event: PrivacyAuditEvent) => void;
}

/**
 * Where a text comes from. `raw` (default): the principal, the application,
 * a tool or the browser's history; it holds originals, so a pseudonym in it
 * is a collision and stops the call. `model`: output this turn's boundary
 * itself received from the model (server-side provenance, never a client
 * claim); it legitimately holds pseudonyms.
 */
export type ProtectedTextOrigin = 'raw' | 'model';

/** One conversation's protected view, loaded once per turn and never shared. */
export interface PrivacySession {
  readonly scope: PrivacyScope;
  readonly profile: typeof PROTECTED_TEXT_PROFILE;
  /** Random id of the mapping generation this session is bound to (never reused). */
  readonly generation: string;
  /** How the mapping was found when the session opened. */
  readonly origin: MappingOrigin;
  /** Registers identities known from the authenticated context or authorized tool results. */
  registerIdentities(identities: ReadonlyArray<KnownIdentity>): Promise<void>;
  /**
   * Replaces detected and already-mapped originals with their pseudonyms. A
   * `raw` text that contains a pseudonym of this scope is refused with
   * `privacy_mapping_conflict`: it could not be told apart on the way back.
   */
  pseudonymizeText(text: string, options?: { origin?: ProtectedTextOrigin }): Promise<string>;
  /** Same for JSON: string values, object keys and numbers that are mapped ids. */
  pseudonymizeJson<T>(value: T, options?: { origin?: ProtectedTextOrigin }): Promise<T>;
  /** Pseudonyms → originals, only within this scope (also a date, phone or IBAN pseudonym in another format). */
  rehydrateText(text: string): string;
  rehydrateJson<T>(value: T): T;
  /**
   * Rehydration for a tool that executes: like `rehydrateJson`, but refuses
   * (`privacy_mapping_conflict`) when a fake date of birth remains in a
   * form that cannot be mapped back, so no invented value reaches the tool.
   */
  rehydrateToolInput<T>(value: T): T;
  /** Keyed digest of one canonical history part, bound to this scope and generation. */
  bindingDigest(canonical: string): string;
  /** True when this generation produced or accepted the canonical part. */
  isBound(canonical: string): boolean;
  /** Records canonical parts as content of this generation. */
  bind(canonicals: ReadonlyArray<string>): Promise<void>;
  /** Number of protected originals (not single name parts) present in `text`. */
  countLeaks(text: string): number;
  /** Number of mapping entries currently known. */
  size(): number;
}

export interface StrictPiiShield {
  readonly profile: typeof PROTECTED_TEXT_PROFILE;
  open(scope: PrivacyScope, options?: { signal?: AbortSignal }): Promise<PrivacySession>;
  /** Convenience: pseudonymize one text in a scope. */
  outbound(text: string, scope: PrivacyScope): Promise<string>;
  /** Tombstones the scope's mapping. */
  deleteMapping(scope: PrivacyScope): Promise<void>;
}

const CASE_INSENSITIVE = new Set(['person', 'email', 'name-full']);
const LEAK_CATEGORIES_EXCLUDED = new Set(['name-first', 'name-last']);
// Letters, digits and `_` continue a word. `@` and `.` do not: "@Anna" and
// "Dr.Muster" name the person. A registered e-mail address is a longer
// span at the same start and wins over its name parts.
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';
/** Invisible format characters (zero-width space/joiner, soft hyphen, bidi marks). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * The form a text is matched and sent in: NFKC (fullwidth and other
 * compatibility forms fold to their plain letters) without invisible format
 * characters, so "Ａｎｎａ" or "A\u200bnna" cannot slip past a matcher.
 */
export function foldProtectedText(text: string): string {
  return text.normalize('NFKC').replace(FORMAT_CHARACTERS, '');
}
const MAX_APPEND_ATTEMPTS = 6;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lowerKey(value: string): string {
  return normalizeMappingValue(value).toLowerCase();
}

interface Index {
  byOriginal: Map<string, MappingEntry>;
  byOriginalLower: Map<string, MappingEntry>;
  byPseudonym: Map<string, MappingEntry>;
  originalMatcher: RegExp | null;
  originalMatcherCi: RegExp | null;
  pseudonymMatcher: RegExp | null;
  /** Fake birth date (iso) → original birth date (iso); `null` when two originals share it. */
  birthByFakeIso: Map<string, string | null>;
  /** Original birth date (iso) → fake birth date (iso). */
  birthByOriginalIso: Map<string, string>;
  /** Normalized phone/IBAN pseudonym → entry. */
  byNumberPseudonym: Map<string, MappingEntry>;
}

const NUMBER_CATEGORIES = new Set(['phone', 'iban']);

/** Digits of a phone number in international form; letters and digits of an IBAN. */
function normalizeNumber(category: string, value: string, de: boolean): string {
  if (category === 'iban') return `iban:${value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
  let digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+')) return `phone:${digits}`;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0') && de) digits = `49${digits.slice(1)}`;
  return `phone:${digits}`;
}

function buildMatcher(values: string[], flags: string): RegExp | null {
  const unique = [...new Set(values.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return null;
  return new RegExp(`${BOUNDARY_BEFORE}(?:${unique.map(escapeRegex).join('|')})${BOUNDARY_AFTER}`, flags);
}

function buildIndex(entries: MappingEntry[], de: boolean): Index {
  const byOriginal = new Map<string, MappingEntry>();
  const byOriginalLower = new Map<string, MappingEntry>();
  const byPseudonym = new Map<string, MappingEntry>();
  const birthByFakeIso = new Map<string, string | null>();
  const birthByOriginalIso = new Map<string, string>();
  const byNumberPseudonym = new Map<string, MappingEntry>();
  const exact: string[] = [];
  const ci: string[] = [];
  for (const entry of entries) {
    if (entry.category === 'date_of_birth') {
      const original = parseDate(entry.original);
      const fake = parseDate(entry.pseudonym);
      if (original && fake) {
        const known = birthByFakeIso.get(fake.iso);
        birthByFakeIso.set(fake.iso, known === undefined || known === original.iso ? original.iso : null);
        birthByOriginalIso.set(original.iso, fake.iso);
      }
    }
    if (NUMBER_CATEGORIES.has(entry.category)) {
      byNumberPseudonym.set(normalizeNumber(entry.category, entry.pseudonym, de), entry);
    }
    const original = normalizeMappingValue(entry.original);
    byOriginal.set(original, entry);
    byPseudonym.set(normalizeMappingValue(entry.pseudonym), entry);
    const caseInsensitive = CASE_INSENSITIVE.has(entry.category)
      || ((entry.category === 'name-first' || entry.category === 'name-last') && original.length >= 4);
    if (caseInsensitive) {
      if (!byOriginalLower.has(original.toLowerCase())) byOriginalLower.set(original.toLowerCase(), entry);
      ci.push(original);
    } else {
      exact.push(original);
    }
  }
  return {
    byOriginal,
    byOriginalLower,
    byPseudonym,
    originalMatcher: buildMatcher(exact, 'gu'),
    originalMatcherCi: buildMatcher(ci, 'giu'),
    pseudonymMatcher: buildMatcher([...byPseudonym.keys()], 'gu'),
    birthByFakeIso,
    birthByOriginalIso,
    byNumberPseudonym,
  };
}

const NAME_PART_CATEGORIES = new Set(['name-first', 'name-last']);

/**
 * Case-insensitive matches of a single name part count only when they are
 * written like a name (capitalized or all caps): "Klein" and "KLEIN" match
 * the family name Klein, the adjective "klein" does not.
 */
function nameLikeMatch(entry: MappingEntry | undefined, text: string): boolean {
  if (!entry || !NAME_PART_CATEGORIES.has(entry.category)) return true;
  const first = text.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

interface Span {
  start: number;
  end: number;
  text: string;
  category: string;
}

function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Span[] = [];
  let cursor = -1;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    kept.push(span);
    cursor = span.end;
  }
  return kept;
}

function matchAll(matcher: RegExp | null, text: string, category: string): Span[] {
  if (!matcher) return [];
  const spans: Span[] = [];
  matcher.lastIndex = 0;
  for (const match of text.matchAll(matcher)) {
    spans.push({ start: match.index!, end: match.index! + match[0].length, text: match[0], category });
  }
  return spans;
}

/**
 * The protected-text shield (`protected-text/v1`): every failure of a
 * detector, the store, a key or the scope stops the call with a content-free
 * `PrivacyError`; a failure is never treated as "nothing found". The legacy
 * `createPiiShield` does not give these guarantees.
 */
export function createStrictPiiShield(config: StrictPiiShieldConfig): StrictPiiShield {
  const detectors = config.detectors ?? [createRegexPiiDetector({ dateOfBirth: 'context' })];
  const numberScanner = createRegexPiiDetector({ categories: ['phone', 'iban'] });
  const de = config.locale.toLowerCase().startsWith('de');
  for (const detector of detectors) {
    if (isRemoteDetector(detector)) throw new PrivacyError('privacy_remote_detector_rejected');
  }
  if (!config.store.persistent && !config.allowEphemeralStore) {
    throw new PrivacyError('privacy_store_not_persistent');
  }
  const locales = [config.locale];

  async function open(scope: PrivacyScope, options: { signal?: AbortSignal } = {}): Promise<PrivacySession> {
    assertPrivacyScope(scope);
    const frozenScope = Object.freeze({ ...scope });
    let snapshot: MappingSnapshot = await config.store.load(frozenScope);
    const generation = snapshot.generation;
    const origin = snapshot.origin;
    const bindings = new Set(snapshot.bindings);
    let index = buildIndex(snapshot.entries, de);
    const audit = (type: PrivacyAuditEvent['type'], categories: Record<string, number>) => {
      if (!config.onAudit) return;
      try {
        config.onAudit({ type, scope: { tenantId: scope.tenantId, principalId: scope.principalId }, categories });
      } catch {
        // Audit sinks never break the protected path.
      }
    };

    async function reload() {
      const next = await config.store.load(frozenScope);
      // A turn stays on the generation it opened with.
      if (next.generation !== generation) throw new PrivacyError('privacy_mapping_conflict');
      snapshot = next;
      index = buildIndex(snapshot.entries, de);
    }

    function lookupOriginal(value: string): MappingEntry | undefined {
      const key = normalizeMappingValue(value);
      return index.byOriginal.get(key) ?? index.byOriginalLower.get(key.toLowerCase());
    }

    /**
     * Ensures each (original, category) has an entry. `pseudonymFor` may
     * derive a pseudonym from entries ensured earlier (full names from parts).
     */
    async function ensure(
      requests: Array<{ original: string; category: string; pseudonymFor?: () => string | undefined }>,
      options: { rejectPseudonymCollision?: boolean } = {},
    ): Promise<void> {
      if (options.rejectPseudonymCollision) {
        // A known original that equals an existing pseudonym could not be told
        // apart in model output: stop instead of guessing.
        for (const r of requests) {
          const asPseudonym = index.byPseudonym.get(normalizeMappingValue(r.original));
          if (asPseudonym && normalizeMappingValue(asPseudonym.original) !== normalizeMappingValue(r.original)) {
            throw new PrivacyError('privacy_mapping_conflict');
          }
        }
      }
      let pending = requests.filter((r) => !lookupOriginal(r.original) && !index.byPseudonym.has(normalizeMappingValue(r.original)));
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt >= MAX_APPEND_ATTEMPTS) throw new PrivacyError('privacy_mapping_conflict');
        const taken = new Set([...index.byPseudonym.keys(), ...index.byOriginal.keys()].map(lowerKey));
        const batch: MappingEntry[] = [];
        const seen = new Set<string>();
        for (const request of pending) {
          const key = normalizeMappingValue(request.original);
          if (seen.has(key)) continue;
          seen.add(key);
          let pseudonym = attempt === 0 ? request.pseudonymFor?.() : undefined;
          for (let tries = 0; pseudonym === undefined || taken.has(lowerKey(pseudonym)) || lowerKey(pseudonym) === lowerKey(request.original); tries++) {
            if (tries > 40) throw new PrivacyError('privacy_mapping_conflict');
            pseudonym = generatePseudonym(request.category, request.original, config.locale, attempt + tries);
          }
          taken.add(lowerKey(pseudonym));
          batch.push({ original: key, pseudonym, category: request.category });
        }
        const result = await config.store.append(frozenScope, generation, batch);
        if (result.notInserted.length === 0) {
          snapshot = { ...snapshot, version: result.version, entries: [...snapshot.entries, ...batch] };
          index = buildIndex(snapshot.entries, de);
          pending = [];
          break;
        }
        await reload();
        pending = pending.filter((r) => !lookupOriginal(r.original));
      }
    }

    async function detect(text: string): Promise<Span[]> {
      // A date of birth in a form this profile cannot read and map back
      // ("15.01.80", "01/15/1980", "Dec 12, 1976") is refused, never sent.
      for (const match of text.matchAll(BIRTH_DATE_LIKE)) {
        if (!parseDate(match[0])) throw new PrivacyError('privacy_unsupported_content');
      }
      const spans: Span[] = [];
      for (const detector of detectors) {
        const entities: PiiEntity[] = await detectOrThrow(detector, text, locales, {
          deadlineMs: config.detectorDeadlineMs,
          signal: options.signal,
        });
        for (const e of entities) spans.push({ start: e.start, end: e.end, text: e.text, category: String(e.type) });
      }
      spans.push(...matchAll(index.originalMatcher, text, 'known'));
      spans.push(...matchAll(index.originalMatcherCi, text, 'known').filter((span) => nameLikeMatch(lookupOriginal(span.text), span.text)));
      // A known date of birth in another format (ISO, "15. Januar 1980")
      // is protected too, with the same fake date in that format.
      if (index.birthByOriginalIso.size > 0) {
        for (const match of text.matchAll(DATE_TOKEN)) {
          const parsed = parseDate(match[0]);
          if (parsed && index.birthByOriginalIso.has(parsed.iso) && !lookupOriginal(match[0])) {
            spans.push({ start: match.index!, end: match.index! + match[0].length, text: match[0], category: 'date_of_birth' });
          }
        }
      }
      return resolveOverlaps(spans).filter((span) => !index.byPseudonym.has(normalizeMappingValue(span.text)));
    }

    /** Throws when a raw text holds a pseudonym of this scope (in any format we map back). */
    function assertNoPseudonym(text: string): void {
      if (index.pseudonymMatcher) {
        index.pseudonymMatcher.lastIndex = 0;
        if (index.pseudonymMatcher.test(text)) throw new PrivacyError('privacy_mapping_conflict');
      }
      if (index.birthByFakeIso.size > 0) {
        for (const match of text.matchAll(DATE_TOKEN)) {
          const parsed = parseDate(match[0]);
          if (parsed && index.birthByFakeIso.has(parsed.iso)) throw new PrivacyError('privacy_mapping_conflict');
        }
      }
      if (index.byNumberPseudonym.size > 0) {
        for (const found of numberScanner.detect(text, [config.locale]) as PiiEntity[]) {
          if (index.byNumberPseudonym.has(normalizeNumber(String(found.type), found.text, de))) throw new PrivacyError('privacy_mapping_conflict');
        }
      }
    }

    /** Pseudonym of a date of birth: one fake date per original, in the format of each occurrence. */
    function birthPseudonymFor(original: string): (() => string | undefined) | undefined {
      const parsed = parseDate(original);
      if (!parsed) return undefined;
      return () => {
        const fakeIso = index.birthByOriginalIso.get(parsed.iso);
        return fakeIso ? formatDate(fakeIso, parsed.format) : undefined;
      };
    }

    /** After a date of birth is mapped, map its dotted and ISO forms to the same fake date. */
    async function ensureBirthVariants(originals: string[]): Promise<void> {
      const variants: Array<{ original: string; category: string; pseudonymFor?: () => string | undefined }> = [];
      for (const original of originals) {
        const parsed = parseDate(original);
        if (!parsed) continue;
        for (const format of ['dotted', 'iso'] as const) {
          const variant = formatDate(parsed.iso, format);
          if (!lookupOriginal(variant)) variants.push({ original: variant, category: 'date_of_birth', pseudonymFor: birthPseudonymFor(variant) });
        }
      }
      if (variants.length > 0) await ensure(variants);
    }

    async function pseudonymizeText(text: string, options: { origin?: ProtectedTextOrigin } = {}): Promise<string> {
      if (typeof text !== 'string' || text.length === 0) return text;
      const normalized = foldProtectedText(text);
      if ((options.origin ?? 'raw') === 'raw') assertNoPseudonym(normalized);
      const spans = await detect(normalized);
      if (spans.length === 0) return normalized;
      await ensure(spans.filter((s) => s.category !== 'known').map((s) => ({
        original: s.text,
        category: s.category,
        ...(s.category === 'date_of_birth' ? { pseudonymFor: birthPseudonymFor(s.text) } : {}),
      })));
      const births = spans.filter((s) => s.category === 'date_of_birth').map((s) => s.text);
      if (births.length > 0) await ensureBirthVariants(births);
      const categories: Record<string, number> = {};
      let out = '';
      let cursor = 0;
      for (const span of spans) {
        const entry = lookupOriginal(span.text);
        if (!entry) throw new PrivacyError('privacy_mapping_conflict');
        out += normalized.slice(cursor, span.start) + entry.pseudonym;
        cursor = span.end;
        categories[entry.category] = (categories[entry.category] ?? 0) + 1;
      }
      audit('pseudonymized', categories);
      return out + normalized.slice(cursor);
    }

    async function pseudonymizeBirthValue(value: string, textOptions: { origin?: ProtectedTextOrigin }): Promise<string> {
      const folded = foldProtectedText(value).trim();
      // An ISO timestamp keeps its time part; the date part is the birth date.
      const datePart = /^\d{4}-\d{2}-\d{2}(?=T|$)/.exec(folded)?.[0] ?? folded;
      if (!parseDate(datePart)) {
        // A birth date we cannot read could not be mapped back: refuse.
        throw new PrivacyError('privacy_unsupported_content');
      }
      if ((textOptions.origin ?? 'raw') === 'raw') assertNoPseudonym(folded);
      if (!lookupOriginal(datePart)) {
        await ensure([{ original: datePart, category: 'date_of_birth', pseudonymFor: birthPseudonymFor(datePart) }]);
      }
      await ensureBirthVariants([datePart]);
      const entry = lookupOriginal(datePart);
      if (!entry) throw new PrivacyError('privacy_mapping_conflict');
      audit('pseudonymized', { date_of_birth: 1 });
      return entry.pseudonym + folded.slice(datePart.length);
    }

    async function pseudonymizeJson(value: unknown, depth = 0, textOptions: { origin?: ProtectedTextOrigin } = {}, key?: string): Promise<unknown> {
      if (depth > 64) throw new PrivacyError('privacy_unsupported_content');
      if (typeof value === 'string' && key !== undefined && BIRTH_DATE_KEY.test(key) && value.trim().length > 0) {
        return pseudonymizeBirthValue(value, textOptions);
      }
      if (typeof value === 'string') return pseudonymizeText(value, textOptions);
      if (typeof value === 'number' || typeof value === 'bigint') {
        // Only a registered id maps a number; quantities and other numbers
        // never match, since short numeric ids are not registered.
        const entry = index.byOriginal.get(String(value));
        if (!entry || entry.category !== 'identity-id') return value;
        const asNumber = Number(entry.pseudonym);
        return Number.isFinite(asNumber) && typeof value === 'number' ? asNumber : entry.pseudonym;
      }
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) out.push(await pseudonymizeJson(item, depth + 1, textOptions, key));
        return out;
      }
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        throw new PrivacyError('privacy_binary_content_blocked');
      }
      if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
          out[await pseudonymizeText(childKey, textOptions)] = await pseudonymizeJson(child, depth + 1, textOptions, childKey);
        }
        return out;
      }
      return value;
    }

    function rehydrateText(text: string): string {
      if (typeof text !== 'string' || text.length === 0) return text;
      const spans: Array<Span & { replacement: string }> = [];
      if (index.pseudonymMatcher) {
        for (const span of matchAll(index.pseudonymMatcher, text, 'pseudonym')) {
          const entry = index.byPseudonym.get(normalizeMappingValue(span.text));
          if (entry) spans.push({ ...span, replacement: entry.original });
        }
      }
      // A fake birth date the model wrote in another format maps back by value.
      if (index.birthByFakeIso.size > 0) {
        for (const match of text.matchAll(DATE_TOKEN)) {
          const parsed = parseDate(match[0]);
          if (!parsed || !index.birthByFakeIso.has(parsed.iso)) continue;
          const originalIso = index.birthByFakeIso.get(parsed.iso);
          if (originalIso === null || originalIso === undefined) throw new PrivacyError('privacy_mapping_conflict');
          spans.push({ start: match.index!, end: match.index! + match[0].length, text: match[0], category: 'date', replacement: formatDate(originalIso, parsed.format) });
        }
      }
      // A phone number or IBAN pseudonym with other spacing or prefix maps back too.
      if (index.byNumberPseudonym.size > 0) {
        for (const found of numberScanner.detect(text, [config.locale]) as PiiEntity[]) {
          const entry = index.byNumberPseudonym.get(normalizeNumber(String(found.type), found.text, de));
          if (entry) spans.push({ start: found.start, end: found.end, text: found.text, category: 'number', replacement: entry.original });
        }
      }
      if (spans.length === 0) return text;
      let out = '';
      let cursor = 0;
      let count = 0;
      for (const span of resolveOverlaps(spans) as Array<Span & { replacement: string }>) {
        out += text.slice(cursor, span.start) + span.replacement;
        cursor = span.end;
        count += 1;
      }
      audit('rehydrated', { total: count });
      return out + text.slice(cursor);
    }

    function assertNoUnmappedBirthDate(value: unknown, depth = 0): void {
      if (depth > 64 || index.birthByFakeIso.size === 0) return;
      if (typeof value === 'string') {
        // Readable dates were mapped back already (or are real dates); what
        // is left is checked for a fake date in a form we cannot read.
        const rest = value.replace(DATE_TOKEN, ' ');
        for (const fakeIso of index.birthByFakeIso.keys()) {
          if (mentionsDateLoosely(rest, fakeIso)) throw new PrivacyError('privacy_mapping_conflict');
        }
      } else if (Array.isArray(value)) {
        for (const item of value) assertNoUnmappedBirthDate(item, depth + 1);
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          assertNoUnmappedBirthDate(key, depth + 1);
          assertNoUnmappedBirthDate(child, depth + 1);
        }
      }
    }

    function rehydrateJson(value: unknown, depth = 0): unknown {
      if (depth > 64) return value;
      if (typeof value === 'string') return rehydrateText(value);
      if (typeof value === 'number') {
        const entry = index.byPseudonym.get(String(value));
        if (!entry || entry.category !== 'identity-id') return value;
        const original = Number(entry.original);
        return Number.isFinite(original) ? original : entry.original;
      }
      if (Array.isArray(value)) return value.map((item) => rehydrateJson(item, depth + 1));
      if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          out[rehydrateText(key)] = rehydrateJson(child, depth + 1);
        }
        return out;
      }
      return value;
    }

    async function registerIdentities(identities: ReadonlyArray<KnownIdentity>): Promise<void> {
      const parts: Array<{ original: string; category: string }> = [];
      const plans: Array<{ identity: KnownIdentity; plan: ReturnType<typeof planName> }> = [];
      for (const identity of identities) {
        const plan = identity.name ? planName(identity.name) : null;
        plans.push({ identity, plan });
        for (const part of plan?.parts ?? []) {
          parts.push({ original: part.token, category: part.role === 'last' ? 'name-last' : 'name-first' });
        }
      }
      await ensure(parts, { rejectPseudonymCollision: true });
      // Every token of the fake full name is a pseudonym: a short token
      // without its own mapping (e.g. "Li") gets a filler, never itself.
      const pseudoOf = (token: string) => lookupOriginal(token)?.pseudonym ?? fillerFirstName(config.locale);
      const derived: Array<{ original: string; category: string; pseudonymFor?: () => string | undefined }> = [];
      for (const { identity, plan } of plans) {
        let fakeFull: string | undefined;
        if (plan && plan.full.includes(' ')) {
          const tokens = plan.full.split(' ');
          fakeFull = tokens.map(pseudoOf).join(' ');
          const variants = nameVariants(plan.full);
          const fakeVariants = nameVariants(fakeFull);
          variants.forEach((variant, i) => {
            derived.push({ original: variant, category: 'name-full', pseudonymFor: () => fakeVariants[i] });
          });
        }
        for (const alias of identity.aliases ?? []) {
          const normalizedAlias = alias.normalize('NFKC').trim();
          if (normalizedAlias.length >= 3) derived.push({ original: normalizedAlias, category: 'person' });
        }
        if (identity.email && identity.email.includes('@')) {
          const tokens = fakeFull?.split(' ');
          derived.push({
            original: identity.email.normalize('NFKC').trim(),
            category: 'email',
            pseudonymFor: () => (tokens && tokens.length >= 2 ? emailFromName(tokens[0]!, tokens[tokens.length - 1]!) : undefined),
          });
        }
        const id = identityIdString(identity.id);
        if (id) derived.push({ original: id, category: 'identity-id' });
      }
      await ensure(derived, { rejectPseudonymCollision: true });
      audit('identities-registered', { total: identities.length });
    }

    function countLeaks(raw: string): number {
      if (typeof raw !== 'string') return 0;
      const text = foldProtectedText(raw);
      let leaks = 0;
      for (const span of [...matchAll(index.originalMatcher, text, 'known'), ...matchAll(index.originalMatcherCi, text, 'known')]) {
        const entry = lookupOriginal(span.text);
        if (entry && !LEAK_CATEGORIES_EXCLUDED.has(entry.category) && !index.byPseudonym.has(normalizeMappingValue(span.text))) leaks += 1;
      }
      return leaks;
    }

    const bindingDigest = (canonical: string) => config.store.bindingDigest(frozenScope, generation, canonical);

    return {
      scope: frozenScope,
      profile: PROTECTED_TEXT_PROFILE,
      generation,
      origin,
      registerIdentities,
      pseudonymizeText,
      pseudonymizeJson: ((value: unknown, options?: { origin?: ProtectedTextOrigin }) => pseudonymizeJson(value, 0, options ?? {})) as PrivacySession['pseudonymizeJson'],
      rehydrateText,
      rehydrateJson: rehydrateJson as PrivacySession['rehydrateJson'],
      rehydrateToolInput: ((value: unknown) => {
        const out = rehydrateJson(value);
        assertNoUnmappedBirthDate(out);
        return out;
      }) as PrivacySession['rehydrateToolInput'],
      bindingDigest,
      isBound: (canonical) => bindings.has(bindingDigest(canonical)),
      async bind(canonicals) {
        const digests = canonicals.map(bindingDigest);
        await config.store.bind(frozenScope, generation, digests);
        for (const digest of digests) bindings.add(digest);
      },
      countLeaks,
      size: () => snapshot.entries.length,
    };
  }

  return {
    profile: PROTECTED_TEXT_PROFILE,
    open,
    async outbound(text, scope) {
      const session = await open(scope);
      return session.pseudonymizeText(text);
    },
    deleteMapping: (scope) => config.store.delete(scope),
  };
}
