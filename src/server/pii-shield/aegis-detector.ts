import type { PiiDetector, PiiEntity } from '../../types.js';
import { REMOTE_DETECTOR } from './detection-result.js';

/**
 * Shape of an Aegis-compatible analyze method (duck-typed, no Lancer dep).
 * Matches `lancer.aegis.analyze()`.
 */
export interface AegisLike {
  analyze(text: string, locales: string[]): Promise<{
    entities: Array<{
      type: string;
      start: number;
      end: number;
      value: string;
      confidence?: number;
    }>;
  }>;
}

/**
 * Creates a PiiDetector that delegates to a Lancer Aegis namespace.
 *
 * Legacy: it sends raw text to the injected `analyze`, which may run off the
 * host. The protected-text profile (`createStrictPiiShield`) refuses it.
 *
 * Usage:
 * ```ts
 * import { createAegisDetector } from './index.js';
 * const detector = createAegisDetector(lancer.aegis);
 * ```
 */
export function createAegisDetector(aegis: AegisLike): PiiDetector {
  const detector: PiiDetector & { [REMOTE_DETECTOR]: true } = {
    [REMOTE_DETECTOR]: true,
    async detect(text: string, locales?: string[]): Promise<PiiEntity[]> {
      const result = await aegis.analyze(text, locales ?? ['de', 'en']);
      return result.entities.map((e) => ({
        type: e.type,
        start: e.start,
        end: e.end,
        score: e.confidence ?? 1.0,
        text: e.value,
      }));
    },
  };
  return detector;
}
