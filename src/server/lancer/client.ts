// ---------------------------------------------------------------------------
// createLancer — factory for the Lancer platform client
// ---------------------------------------------------------------------------

import { Cache } from './cache.js';
import { ServiceBlockedError } from './errors.js';
import { TelemetryBuffer } from './telemetry-buffer.js';
import type {
  AnalyzeOptions,
  AnalyzeResult,
  ApprovalCheckResult,
  ApprovalDecideResult,
  ApprovalResolveResult,
  CheckResult,
  ClassifyResult,
  ConfigResult,
  DegradationAction,
  DegradationDefaults,
  Lancer,
  LancerConfig,
  LancerServiceName,
  LeakageResult,
  OnServiceUnavailable,
  TelemetryEvent,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.glirastes.chainmatics.io';
const DEFAULT_CACHE_TTL = 60_000;
const DEFAULT_MAX_RETRIES = 3;

/** Built-in action per service when nothing is explicitly configured. */
const SERVICE_DEFAULT_ACTIONS: Record<LancerServiceName, DegradationAction> = {
  warden: 'fallback',
  primus: 'fallback',
  aegis: 'fallback',
  proctor: 'silent', // telemetry-only service — failures are always silent
  config: 'fallback',
  approvals: 'fallback',
};

interface DegradationCfg {
  defaults?: DegradationDefaults;
  onServiceUnavailable?: OnServiceUnavailable;
  onDegraded?: () => void;
}

/**
 * Call `fn`; on failure resolve the degradation action for `service` and act:
 * - 'fallback': call onDegraded (if set) and return `fallback`.
 * - 'silent':   return `fallback` without calling onDegraded.
 * - 'block':    throw ServiceBlockedError (propagates to the caller).
 *
 * Resolution order: onServiceUnavailable callback > degradation defaults > built-in default.
 */
async function callWithFallback<T>(
  fn: () => Promise<T>,
  fallback: T,
  service: LancerServiceName,
  cfg: DegradationCfg,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // 1. Start from static default
    let action: DegradationAction = cfg.defaults?.[service] ?? SERVICE_DEFAULT_ACTIONS[service];

    // 2. Let the dynamic callback override (last word)
    if (cfg.onServiceUnavailable) {
      action = await cfg.onServiceUnavailable({ service, error });
    }

    if (action === 'block') {
      throw new ServiceBlockedError(service, error);
    }

    if (action === 'fallback') {
      cfg.onDegraded?.();
    }
    // 'silent': return fallback without notifying

    return fallback;
  }
}

export function createLancer(config: LancerConfig): Lancer {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const cacheTtl = config.cache?.ttl ?? DEFAULT_CACHE_TTL;
  const maxRetries = config.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;

  const agentId = config.agentId;
  const agentType = config.agentType;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
    ...(agentType ? { 'X-Agent-Type': agentType } : {}),
  };

  const cache = new Cache<unknown>(cacheTtl);

  const telemetryBuffer = new TelemetryBuffer(
    `${baseUrl}/v1/proctor/events`,
    headers,
    maxRetries,
  );

  // Track config ETags per cache-key for conditional requests
  const etags = new Map<string, string>();

  // Shared degradation config — built once, reused by every callWithFallback call.
  const degradationCfg: DegradationCfg = {
    defaults: config.degradation,
    onServiceUnavailable: config.onServiceUnavailable,
    onDegraded: config.onDegraded,
  };

  // ------ API helpers ------------------------------------------------------

  async function apiFetch<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: { ...headers, ...(init?.headers as Record<string, string>) },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // ------ Primus namespace (intent classification) -------------------------

  const primus = {
    async classify(message: string, modules: { moduleId: string }[], locale?: string): Promise<ClassifyResult> {
      const moduleIds = modules.map(m => m.moduleId);
      return callWithFallback(
        () => apiFetch<ClassifyResult>('/v1/primus/classify', {
          method: 'POST',
          body: JSON.stringify({ message, modules: moduleIds, ...(locale && { locale }) }),
        }),
        { moduleId: '', confidence: 0, modelTier: 'standard' },
        'primus',
        degradationCfg,
      );
    },
  };

  // ------ Warden namespace (guardrail checks) ------------------------------

  const warden = {
    async check(input: string, policies: string[]): Promise<CheckResult> {
      // Map Glirastes response (policy -> rule) so SDK interface matches
      const result = await callWithFallback(
        async () => {
          const raw = await apiFetch<{ passed: boolean; violations: { policy: string; type: string; message: string; severity: string }[] }>('/v1/warden/check', {
            method: 'POST',
            body: JSON.stringify({ input, policies }),
          });
          return {
            passed: raw.passed,
            violations: raw.violations.map(v => ({
              rule: v.policy,
              severity: v.severity,
              message: v.message,
            })),
          };
        },
        { passed: true, violations: [] } as CheckResult,
        'warden',
        degradationCfg,
      );
      return result;
    },
  };

  // ------ Aegis namespace (PII detection) ----------------------------------

  const aegis = {
    async analyze(text: string, options?: AnalyzeOptions): Promise<AnalyzeResult> {
      return callWithFallback(
        () => apiFetch<AnalyzeResult>('/v1/aegis/analyze', {
          method: 'POST',
          body: JSON.stringify({
            text,
            locales: options?.locales,
            mode: options?.mode ?? 'pseudonymize',
            sessionId: options?.sessionId,
          }),
        }),
        { entities: [], anonymized: text, mappingToken: null },
        'aegis',
        degradationCfg,
      );
    },
    async rehydrate(text: string, mappingToken: string): Promise<string> {
      const result = await callWithFallback(
        () => apiFetch<{ rehydrated: string }>('/v1/aegis/rehydrate', {
          method: 'POST',
          body: JSON.stringify({ text, mappingToken }),
        }),
        { rehydrated: text },
        'aegis',
        degradationCfg,
      );
      return result.rehydrated;
    },
    async checkLeakage(text: string, mappingToken: string, locales?: string[]): Promise<LeakageResult> {
      return callWithFallback(
        () => apiFetch<LeakageResult>('/v1/aegis/check-leakage', {
          method: 'POST',
          body: JSON.stringify({ text, mappingToken, locales }),
        }),
        { leaked: false, entities: [], totalDetected: 0, filteredAsKnown: 0 },
        'aegis',
        degradationCfg,
      );
    },
  };

  // ------ Config namespace -------------------------------------------------

  const configNs = {
    async fetch(modules: string[]): Promise<ConfigResult> {
      const cacheKey = `config:fetch:${modules.sort().join(',')}`;
      const cached = cache.get(cacheKey) as ConfigResult | undefined;
      if (cached) return cached;

      const extraHeaders: Record<string, string> = {};
      const etag = etags.get(cacheKey);
      if (etag) extraHeaders['If-None-Match'] = etag;

      const result = await callWithFallback(
        async () => {
          let lastError: unknown;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const res = await fetch(`${baseUrl}/v1/config?modules=${modules.join(',')}`, {
                method: 'GET',
                headers: { ...headers, ...extraHeaders },
              });

              if (res.status === 304) {
                const prev = cache.get(cacheKey) as ConfigResult | undefined;
                return prev ?? { modules: {} };
              }

              if (!res.ok) throw new Error(`HTTP ${res.status}`);

              const body = (await res.json()) as ConfigResult;
              const newEtag = res.headers.get('etag');
              if (newEtag) etags.set(cacheKey, newEtag);

              return body;
            } catch (err) {
              lastError = err;
            }
          }
          throw lastError;
        },
        { modules: {} } as ConfigResult,
        'config',
        degradationCfg,
      );

      cache.set(cacheKey, result);
      return result;
    },

    async reportModels(models: Record<string, string>): Promise<void> {
      try {
        await apiFetch('/v1/config/models/defaults', {
          method: 'POST',
          body: JSON.stringify({ models }),
        });
      } catch {
        // Fire-and-forget: silently ignore errors
      }
    },
  };

  // ------ Telemetry namespace ----------------------------------------------

  const telemetry = {
    emit(event: TelemetryEvent): void {
      const enrichedEvent: TelemetryEvent = agentId
        ? {
            ...event,
            actor: {
              ...event.actor,
              agentId,
              ...(agentType ? { agentType } : {}),
            },
          }
        : event;
      telemetryBuffer.add(enrichedEvent);
    },
    async flush(): Promise<void> {
      // TelemetrySink contract: flush must never throw.
      // Errors are already handled inside TelemetryBuffer (events re-queued).
      try {
        await telemetryBuffer.flush();
      } catch {
        // Silently ignore — telemetry is fire-and-forget
      }
    },
  };

  // ------ Approvals namespace -----------------------------------------------

  const approvals = {
    async check(req: {
      toolId: string;
      inputHash: string;
      traceId?: string;
    }): Promise<ApprovalCheckResult> {
      return callWithFallback(
        () =>
          apiFetch<ApprovalCheckResult>('/v1/approvals/check', {
            method: 'POST',
            body: JSON.stringify(req),
          }),
        { required: true, requestId: null, status: 'local-fallback' } as ApprovalCheckResult,
        'approvals',
        degradationCfg,
      );
    },

    async decide(
      requestId: string,
      decision: { decision: 'approved' | 'denied'; decidedBy: string },
    ): Promise<ApprovalDecideResult> {
      return callWithFallback(
        () =>
          apiFetch<ApprovalDecideResult>(`/v1/approvals/pending/${requestId}/decide`, {
            method: 'POST',
            body: JSON.stringify(decision),
          }),
        { ok: false },
        'approvals',
        degradationCfg,
      );
    },

    async resolve(req: {
      toolId: string;
      inputHash: string;
      decision: 'approved' | 'denied';
      decidedBy: string;
    }): Promise<ApprovalResolveResult> {
      return callWithFallback(
        () =>
          apiFetch<ApprovalResolveResult>('/v1/approvals/resolve', {
            method: 'POST',
            body: JSON.stringify(req),
          }),
        { resolved: false },
        'approvals',
        degradationCfg,
      );
    },

    hashInput(args: Record<string, unknown>): string {
      // Deterministic JSON hash: recursively sort keys, stringify, then hash
      const sortKeys = (_: string, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.keys(v as Record<string, unknown>).sort().reduce((o, k) => {
              o[k] = (v as Record<string, unknown>)[k];
              return o;
            }, {} as Record<string, unknown>)
          : v;
      const sorted = JSON.stringify(args, sortKeys);
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        const char = sorted.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
      }
      return hash.toString(36);
    },
  };

  // ------ Public surface ---------------------------------------------------

  return {
    primus,
    warden,
    aegis,
    config: configNs,
    telemetry,
    approvals,
    destroy() {
      telemetryBuffer.destroy();
      cache.clear();
    },
  };
}
