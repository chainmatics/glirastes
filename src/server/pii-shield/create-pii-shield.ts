import type {
  PiiShield,
  PiiShieldConfig,
  PiiAuditEntry,
  ComplianceSummary,
  PiiEntity,
} from '../../types.js';
import { createSessionStore } from './session-mapping.js';
import { deepWalkReplace } from './deep-walk.js';
import { decodeJsonStrings } from './detection-text.js';
import { detectLeakage } from './leakage.js';

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
  /**
   * Per session, the originals found in plain text (outbound) or in a result's
   * JSON text, in the order they were learned. anonymizeResult replaces these
   * first, in this order, and only then the originals found only in a result's
   * decoded text: so it replaces at least what it replaced before those were
   * learned, and an earlier decoded-only value never cuts into a later one.
   */
  const firstOrder = new Map<string, Set<string>>();

  function learnFirst(sessionId: string, original: string): void {
    let order = firstOrder.get(sessionId);
    if (!order) firstOrder.set(sessionId, order = new Set());
    order.add(original);
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
      learnFirst(sessionId, entity.text);
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

    // Replace pseudonyms with originals
    const originals = session.allOriginals();
    let result = text;
    for (const original of originals) {
      const pseudonym = session.getPseudonym(original);
      if (!pseudonym) continue;
      result = result.split(pseudonym).join(original);
    }

    return result;
  }

  function rehydrateArgs(
    args: Record<string, unknown>,
    sessionId: string,
  ): Record<string, unknown> {
    const session = store.getOrCreate(sessionId);

    const result = deepWalkReplace(args, (s: string) => {
      // Check if the entire string is a known pseudonym
      const original = session.resolveOriginal(s);
      if (original) return original;

      // Check if any known pseudonyms appear as substrings
      const originals = session.allOriginals();
      let replaced = s;
      for (const orig of originals) {
        const pseudonym = session.getPseudonym(orig);
        if (!pseudonym) continue;
        replaced = replaced.split(pseudonym).join(orig);
      }
      return replaced;
    }) as Record<string, unknown>;

    addAuditEntry(buildAuditEntry(sessionId, 'rehydrate-args', []));
    return result;
  }

  async function anonymizeResult(result: unknown, sessionId: string): Promise<unknown> {
    const session = store.getOrCreate(sessionId);
    const stats = getStats(sessionId);
    stats.totalToolCalls++;

    // Detect PII in the JSON text (as always), and where it has escapes also in
    // the same text with real characters (see decodeJsonStrings): a value right
    // after an escaped line break is only found there. Learned: both, the JSON
    // text's detections first, so its pseudonyms and replacements stay as they were.
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    let detected = await config.detector.detect(text, [config.locale]);
    for (const entity of detected) learnFirst(sessionId, entity.text);
    const decoded = typeof result === 'string' ? text : decodeJsonStrings(text);
    if (decoded !== text) {
      const known = new Set(detected.map((entity) => entity.text));
      const more = await config.detector.detect(decoded, [config.locale]);
      detected = [...detected, ...more.filter((entity) => !known.has(entity.text))];
    }

    // Ensure pseudonyms exist for all detected entities
    for (const entity of detected) {
      session.getOrCreatePseudonym(entity.text, entity.type);
    }

    // Deep-walk and replace originals with pseudonyms
    const first = firstOrder.get(sessionId) ?? new Set<string>();
    const originals = [...first, ...session.allOriginals().filter((original) => !first.has(original))];
    const anonymized = deepWalkReplace(result, (s: string) => {
      let replaced = s;
      for (const original of originals) {
        const pseudonym = session.getPseudonym(original);
        if (!pseudonym) continue;
        replaced = replaced.split(original).join(pseudonym);
      }
      return replaced;
    });

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
    firstOrder.delete(sessionId);
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
