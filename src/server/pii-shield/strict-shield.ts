import type { PiiDetector, PiiEntity } from '../../types.js';
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
  type MappingSnapshot,
  type PrivacyMappingStore,
  type PrivacyScope,
} from './mapping-store.js';
import { emailFromName, generatePseudonym } from './pseudonyms.js';
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

/** One conversation's protected view, loaded once per turn and never shared. */
export interface PrivacySession {
  readonly scope: PrivacyScope;
  readonly profile: typeof PROTECTED_TEXT_PROFILE;
  /** Registers identities known from the authenticated context or authorized tool results. */
  registerIdentities(identities: ReadonlyArray<KnownIdentity>): Promise<void>;
  /** Replaces detected and already-mapped originals with their pseudonyms. */
  pseudonymizeText(text: string): Promise<string>;
  /** Same for JSON: string values, object keys and numbers that are mapped ids. */
  pseudonymizeJson<T>(value: T): Promise<T>;
  /** Pseudonyms → originals, only within this scope. */
  rehydrateText(text: string): string;
  rehydrateJson<T>(value: T): T;
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
}

function buildMatcher(values: string[], flags: string): RegExp | null {
  const unique = [...new Set(values.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return null;
  return new RegExp(`${BOUNDARY_BEFORE}(?:${unique.map(escapeRegex).join('|')})${BOUNDARY_AFTER}`, flags);
}

function buildIndex(entries: MappingEntry[]): Index {
  const byOriginal = new Map<string, MappingEntry>();
  const byOriginalLower = new Map<string, MappingEntry>();
  const byPseudonym = new Map<string, MappingEntry>();
  const exact: string[] = [];
  const ci: string[] = [];
  for (const entry of entries) {
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
  };
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
  const detectors = config.detectors ?? [createRegexPiiDetector()];
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
    let index = buildIndex(snapshot.entries);
    const audit = (type: PrivacyAuditEvent['type'], categories: Record<string, number>) => {
      if (!config.onAudit) return;
      try {
        config.onAudit({ type, scope: { tenantId: scope.tenantId, principalId: scope.principalId }, categories });
      } catch {
        // Audit sinks never break the protected path.
      }
    };

    async function reload() {
      snapshot = await config.store.load(frozenScope);
      index = buildIndex(snapshot.entries);
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
        const result = await config.store.append(frozenScope, snapshot.generation, batch);
        if (result.notInserted.length === 0) {
          snapshot = { ...snapshot, version: result.version, entries: [...snapshot.entries, ...batch] };
          index = buildIndex(snapshot.entries);
          pending = [];
          break;
        }
        await reload();
        pending = pending.filter((r) => !lookupOriginal(r.original));
      }
    }

    async function detect(text: string): Promise<Span[]> {
      const spans: Span[] = [];
      for (const detector of detectors) {
        const entities: PiiEntity[] = await detectOrThrow(detector, text, locales, {
          deadlineMs: config.detectorDeadlineMs,
          signal: options.signal,
        });
        for (const e of entities) spans.push({ start: e.start, end: e.end, text: e.text, category: String(e.type) });
      }
      spans.push(...matchAll(index.originalMatcher, text, 'known'));
      spans.push(...matchAll(index.originalMatcherCi, text, 'known'));
      return resolveOverlaps(spans).filter((span) => !index.byPseudonym.has(normalizeMappingValue(span.text)));
    }

    async function pseudonymizeText(text: string): Promise<string> {
      if (typeof text !== 'string' || text.length === 0) return text;
      const normalized = foldProtectedText(text);
      const spans = await detect(normalized);
      if (spans.length === 0) return normalized;
      await ensure(spans.filter((s) => s.category !== 'known').map((s) => ({ original: s.text, category: s.category })));
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

    async function pseudonymizeJson(value: unknown, depth = 0): Promise<unknown> {
      if (depth > 64) throw new PrivacyError('privacy_unsupported_content');
      if (typeof value === 'string') return pseudonymizeText(value);
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
        for (const item of value) out.push(await pseudonymizeJson(item, depth + 1));
        return out;
      }
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        throw new PrivacyError('privacy_binary_content_blocked');
      }
      if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          out[await pseudonymizeText(key)] = await pseudonymizeJson(child, depth + 1);
        }
        return out;
      }
      return value;
    }

    function rehydrateText(text: string): string {
      if (typeof text !== 'string' || !index.pseudonymMatcher) return text;
      let count = 0;
      const out = text.replace(index.pseudonymMatcher, (match) => {
        const entry = index.byPseudonym.get(normalizeMappingValue(match));
        if (!entry) return match;
        count += 1;
        return entry.original;
      });
      if (count > 0) audit('rehydrated', { total: count });
      return out;
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
      const pseudoOf = (token: string) => lookupOriginal(token)?.pseudonym ?? token;
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

    return {
      scope: frozenScope,
      profile: PROTECTED_TEXT_PROFILE,
      registerIdentities,
      pseudonymizeText,
      pseudonymizeJson: pseudonymizeJson as PrivacySession['pseudonymizeJson'],
      rehydrateText,
      rehydrateJson: rehydrateJson as PrivacySession['rehydrateJson'],
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
