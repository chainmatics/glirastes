import type {
  PiiShield,
  PiiShieldConfig,
  PiiAuditEntry,
  ComplianceSummary,
  PiiEntity,
} from '../../types.js';
import { createSessionStore, type Session } from './session-mapping.js';
import { deepWalkReplace } from './deep-walk.js';
import { detectLeakage } from './leakage.js';
import { longestFirst, OVERLAP_PLACEHOLDER, replaceKnown, type Replacements } from './replace-known.js';

interface SessionStats {
  startedAt: number;
  totalMessages: number;
  totalToolCalls: number;
  leakageDetected: number;
}

export function createPiiShield(config: PiiShieldConfig): PiiShield {
  const store = createSessionStore(config.locale);
  const auditLog = new Map<string, PiiAuditEntry[]>();
  const sessionStats = new Map<string, SessionStats>();

  /** Sorted pairs per session, rebuilt when the session learnt a value (it only ever grows). */
  const pairsCache = new WeakMap<Session, { count: number; forward: Replacements; back: Replacements }>();

  /**
   * The session's originals and their pseudonyms, the longest first, for
   * {@link replaceKnown}: `toPseudonym` maps original → pseudonym, otherwise
   * pseudonym → original.
   */
  function knownPairs(session: Session, toPseudonym: boolean): Replacements {
    const originals = session.allOriginals();
    let cached = pairsCache.get(session);
    if (!cached || cached.count !== originals.length) {
      const forward: Array<[string, string]> = [];
      const back: Array<[string, string]> = [];
      for (const original of originals) {
        const pseudonym = session.getPseudonym(original);
        if (!pseudonym) continue;
        forward.push([original, pseudonym]);
        back.push([pseudonym, original]);
      }
      cached = { count: originals.length, forward: longestFirst(forward), back: longestFirst(back) };
      pairsCache.set(session, cached);
    }
    return toPseudonym ? cached.forward : cached.back;
  }

  function getStats(sessionId: string): SessionStats {
    let stats = sessionStats.get(sessionId);
    if (!stats) {
      stats = { startedAt: Date.now(), totalMessages: 0, totalToolCalls: 0, leakageDetected: 0 };
      sessionStats.set(sessionId, stats);
    }
    return stats;
  }

  function addAuditEntry(entry: PiiAuditEntry): void {
    let entries = auditLog.get(entry.sessionId);
    if (!entries) {
      entries = [];
      auditLog.set(entry.sessionId, entries);
    }
    entries.push(entry);
    config.onAudit?.(entry);
  }

  function buildAuditEntry(
    sessionId: string,
    direction: PiiAuditEntry['direction'],
    entities: PiiEntity[],
    opts?: { leakage?: boolean },
  ): PiiAuditEntry {
    return {
      sessionId,
      timestamp: new Date().toISOString(),
      direction,
      leakage: opts?.leakage,
      detections: entities.map((e) => ({
        type: e.type,
        detector: 'pii-shield',
        confidence: e.score,
        position: { start: e.start, end: e.end },
        length: e.text.length,
      })),
      totalDetected: entities.length,
      totalAnonymized: entities.length,
      mode: 'pseudonymize',
      locale: config.locale,
    };
  }

  async function outbound(text: string, sessionId: string): Promise<string> {
    const session = store.getOrCreate(sessionId);
    const stats = getStats(sessionId);
    stats.totalMessages++;

    const detected = await config.detector.detect(text, [config.locale]);

    if (detected.length === 0) {
      addAuditEntry(buildAuditEntry(sessionId, 'outbound', []));
      return text;
    }

    // Sort by start descending so replacements don't shift indices
    const sorted = [...detected].sort((a, b) => b.start - a.start);

    let result = text;
    for (const entity of sorted) {
      const pseudonym = session.getOrCreatePseudonym(entity.text, entity.type);
      result = result.slice(0, entity.start) + pseudonym + result.slice(entity.end);
    }

    addAuditEntry(buildAuditEntry(sessionId, 'outbound', detected));
    return result;
  }

  function inbound(text: string, sessionId: string): string {
    const session = store.getOrCreate(sessionId);

    // Check for leakage BEFORE de-pseudonymization
    if (config.leakageDetection) {
      const originals = session.allOriginals();
      const leaked = detectLeakage(text, originals);
      if (leaked.length > 0) {
        const stats = getStats(sessionId);
        stats.leakageDetected += leaked.length;
        const leakEntities: PiiEntity[] = leaked.map((l) => ({
          type: 'custom',
          start: text.indexOf(l),
          end: text.indexOf(l) + l.length,
          score: 1.0,
          text: l,
        }));
        addAuditEntry(buildAuditEntry(sessionId, 'inbound', leakEntities, { leakage: true }));
      }
    }

    // Replace pseudonyms with originals, the longest pseudonym first, in one pass
    return replaceKnown(text, knownPairs(session, false));
  }

  function rehydrateArgs(
    args: Record<string, unknown>,
    sessionId: string,
  ): Record<string, unknown> {
    const session = store.getOrCreate(sessionId);

    const pairs = knownPairs(session, false);
    const result = deepWalkReplace(args, (s: string) => {
      // Check if the entire string is a known pseudonym
      const original = session.resolveOriginal(s);
      if (original) return original;

      // Known pseudonyms inside the string, the longest first, in one pass
      return replaceKnown(s, pairs);
    }) as Record<string, unknown>;

    addAuditEntry(buildAuditEntry(sessionId, 'rehydrate-args', []));
    return result;
  }

  async function anonymizeResult(result: unknown, sessionId: string): Promise<unknown> {
    const session = store.getOrCreate(sessionId);
    const stats = getStats(sessionId);
    stats.totalToolCalls++;

    // Detect PII in stringified result
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const detected = await config.detector.detect(text, [config.locale]);

    // Ensure pseudonyms exist for all detected entities
    for (const entity of detected) {
      session.getOrCreatePseudonym(entity.text, entity.type);
    }

    // Deep-walk and replace originals with pseudonyms: the longest original
    // first, in one pass, so a known original that is part of a longer one
    // never leaves a piece of the longer one in clear text; the rest of one
    // that only partly overlaps another becomes OVERLAP_PLACEHOLDER (fail
    // closed: no position of a known original reaches the model)
    const pairs = knownPairs(session, true);
    const anonymized = deepWalkReplace(result, (s: string) => replaceKnown(s, pairs, OVERLAP_PLACEHOLDER));

    addAuditEntry(buildAuditEntry(sessionId, 'anonymize-result', detected));
    return anonymized;
  }

  function getComplianceSummary(sessionId: string): ComplianceSummary {
    const stats = getStats(sessionId);
    const entries = auditLog.get(sessionId) ?? [];

    const byType: Record<string, number> = {};
    const byDetector: Record<string, number> = {};
    const byDirection: Record<string, number> = {};
    let totalDetected = 0;

    for (const entry of entries) {
      totalDetected += entry.totalDetected;
      byDirection[entry.direction] = (byDirection[entry.direction] ?? 0) + entry.totalDetected;
      for (const det of entry.detections) {
        byType[det.type] = (byType[det.type] ?? 0) + 1;
        byDetector[det.detector] = (byDetector[det.detector] ?? 0) + 1;
      }
    }

    const durationMs = Date.now() - stats.startedAt;
    const durationSec = Math.floor(durationMs / 1000);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;

    return {
      sessionId,
      duration: `${minutes}m ${seconds}s`,
      totalMessages: stats.totalMessages,
      totalToolCalls: stats.totalToolCalls,
      piiStats: {
        totalDetected,
        byType,
        byDetector,
        byDirection,
      },
      mode: 'pseudonymize',
      leakageDetected: stats.leakageDetected,
      verdict: stats.leakageDetected > 0 ? 'LEAKAGE_DETECTED' : 'COMPLIANT',
    };
  }

  function clearSession(sessionId: string): void {
    store.clear(sessionId);
    auditLog.delete(sessionId);
    sessionStats.delete(sessionId);
  }

  return {
    outbound,
    inbound,
    rehydrateArgs,
    anonymizeResult,
    getComplianceSummary,
    clearSession,
  };
}
