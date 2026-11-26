import type { EnvironmentControlRateLimit } from '../contracts/index.js';

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PRINCIPALS = 10_000;

export type TurnAdmission = { admitted: true } | { admitted: false; retryAfterMs: number };

export interface TurnRateLimiter {
  /** Admits and counts a turn of the principal, or refuses it within the sliding minute. */
  admit(
    principal: { tenantId: string; subjectId: string },
    limit: EnvironmentControlRateLimit | undefined,
  ): TurnAdmission;
  /** Principals currently remembered. */
  size(): number;
}

/**
 * Sliding one-minute window of turns per principal, in this process only:
 * several instances each count their own turns.
 */
export function createTurnRateLimiter(options: {
  now?: () => number;
  maxPrincipals?: number;
} = {}): TurnRateLimiter {
  const now = options.now ?? Date.now;
  const maxPrincipals = Math.max(1, options.maxPrincipals ?? DEFAULT_MAX_PRINCIPALS);
  const turns = new Map<string, number[]>();

  const prune = (at: number) => {
    for (const [key, times] of turns) {
      const recent = times.filter((time) => at - time < WINDOW_MS);
      if (recent.length === 0) turns.delete(key);
      else turns.set(key, recent);
    }
  };

  return {
    admit(principal, limit) {
      if (!limit) return { admitted: true };
      const at = now();
      const key = JSON.stringify([principal.tenantId, principal.subjectId]);
      const recent = (turns.get(key) ?? []).filter((time) => at - time < WINDOW_MS);
      if (recent.length >= limit.maxTurnsPerMinutePerPrincipal) {
        turns.set(key, recent);
        const earliest = recent[recent.length - limit.maxTurnsPerMinutePerPrincipal]!;
        return { admitted: false, retryAfterMs: Math.max(1, earliest + WINDOW_MS - at) };
      }
      recent.push(at);
      // Re-insert so the map stays ordered by the latest turn.
      turns.delete(key);
      turns.set(key, recent);
      if (turns.size > maxPrincipals) prune(at);
      while (turns.size > maxPrincipals) turns.delete(turns.keys().next().value!);
      return { admitted: true };
    },
    size: () => turns.size,
  };
}
