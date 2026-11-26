import { describe, expect, it } from 'vitest';
import type { EnvironmentControl, ExecutionBudget, LocalEnvironmentControlHalt } from '../../contracts/index.js';
import { applyBudgetCeiling } from '../budget.js';
import { AssistantHaltedError, turnControlOf } from '../turn-control.js';
import { createTurnRateLimiter } from '../turn-rate-limit.js';

const control = (patch: Partial<EnvironmentControl> = {}): EnvironmentControl => ({
  kind: 'environment-control',
  schemaVersion: 1,
  tenantId: '019fb710-0000-7000-8000-000000000001',
  targetAppId: '019fb710-0000-7000-8000-000000000005',
  environmentId: '019fb710-0000-7000-8000-000000000006',
  sequence: 3,
  assistant: 'enabled',
  reasonCode: 'operator-tighten',
  issuedAt: '2026-11-26T09:00:00.000Z',
  signature: { algorithm: 'Ed25519', keyId: 'runtime-key', value: 'c2lnbmF0dXJl' },
  ...patch,
});

const localHalt: LocalEnvironmentControlHalt = {
  kind: 'local', assistant: 'halted', reasonCode: 'control_unverifiable', sequence: 2,
  detectedAt: '2026-11-26T09:00:00.000Z',
};

const local: ExecutionBudget = {
  maxModelSteps: 10, maxToolCalls: 20, totalTimeoutMs: 120_000, toolTimeoutMs: 20_000,
  maxInputTokens: 50_000, maxOutputTokens: 10_000, maxEstimatedCostUsd: 2,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 3, maxBreadth: 4, sharedBudget: false },
};

describe('turnControlOf', () => {
  it('lets turns run without a control, and with an enabled one carries its ceiling and rate limit', () => {
    expect(turnControlOf(undefined)).toEqual({ assistant: 'enabled' });
    expect(turnControlOf(control({
      budgetCeiling: { maxToolCalls: 4 }, rateLimit: { maxTurnsPerMinutePerPrincipal: 5 },
    }))).toEqual({
      assistant: 'enabled', budgetCeiling: { maxToolCalls: 4 }, rateLimit: { maxTurnsPerMinutePerPrincipal: 5 },
    });
  });

  it('halts on a signed halt and on a local control_unverifiable halt alike', () => {
    expect(turnControlOf(control({ assistant: 'halted' }))).toEqual({ assistant: 'halted', code: 'assistant_halted' });
    expect(turnControlOf(localHalt)).toEqual({ assistant: 'halted', code: 'assistant_halted' });
  });

  it('halts with control_unknown while the control is not known yet', () => {
    expect(turnControlOf(undefined, { known: false })).toEqual({ assistant: 'halted', code: 'control_unknown' });
    expect(turnControlOf(control(), { known: false })).toEqual({ assistant: 'halted', code: 'control_unknown' });
    expect(turnControlOf(control({ assistant: 'halted' }), { known: false }))
      .toEqual({ assistant: 'halted', code: 'assistant_halted' });
  });

  it('names only the code in the halt error', () => {
    const error = new AssistantHaltedError('assistant_halted');
    expect(error.code).toBe('assistant_halted');
    expect(error.message).not.toMatch(/operator|sequence/);
  });
});

describe('applyBudgetCeiling', () => {
  it('takes the minimum per named field and leaves the other fields untouched', () => {
    expect(applyBudgetCeiling(local, { maxToolCalls: 4, maxEstimatedCostUsd: 0.5 })).toEqual({
      ...local, maxToolCalls: 4, maxEstimatedCostUsd: 0.5,
    });
  });

  it('never raises a limit above the local one', () => {
    expect(applyBudgetCeiling(local, {
      maxModelSteps: 99, maxToolCalls: 999, totalTimeoutMs: 999_999, maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000, maxEstimatedCostUsd: 100,
    })).toEqual(local);
    expect(applyBudgetCeiling(local, undefined)).toBe(local);
  });
});

describe('createTurnRateLimiter', () => {
  const alice = { tenantId: 't1', subjectId: 'alice' };
  const bob = { tenantId: 't1', subjectId: 'bob' };

  it('refuses the (n+1)-th turn of a principal within a minute, not another principal', () => {
    let now = 0;
    const limiter = createTurnRateLimiter({ now: () => now });
    const limit = { maxTurnsPerMinutePerPrincipal: 2 };
    expect(limiter.admit(alice, limit)).toEqual({ admitted: true });
    now = 10_000;
    expect(limiter.admit(alice, limit)).toEqual({ admitted: true });
    now = 20_000;
    expect(limiter.admit(alice, limit)).toEqual({ admitted: false, retryAfterMs: 40_000 });
    expect(limiter.admit(bob, limit)).toEqual({ admitted: true });
    expect(limiter.admit({ tenantId: 't2', subjectId: 'alice' }, limit)).toEqual({ admitted: true });
  });

  it('admits again once the window has slid past the earliest turn', () => {
    let now = 0;
    const limiter = createTurnRateLimiter({ now: () => now });
    const limit = { maxTurnsPerMinutePerPrincipal: 1 };
    expect(limiter.admit(alice, limit).admitted).toBe(true);
    now = 59_999;
    expect(limiter.admit(alice, limit).admitted).toBe(false);
    now = 60_000;
    expect(limiter.admit(alice, limit).admitted).toBe(true);
  });

  it('admits every turn without a limit and keeps nothing for it', () => {
    const limiter = createTurnRateLimiter();
    for (let turn = 0; turn < 1_000; turn += 1) expect(limiter.admit(alice, undefined).admitted).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it('remembers a bounded number of principals', () => {
    let now = 0;
    const limiter = createTurnRateLimiter({ now: () => now, maxPrincipals: 3 });
    const limit = { maxTurnsPerMinutePerPrincipal: 1 };
    for (const subjectId of ['a', 'b', 'c', 'd', 'e']) {
      now += 1;
      limiter.admit({ tenantId: 't1', subjectId }, limit);
    }
    expect(limiter.size()).toBe(3);
    expect(limiter.admit({ tenantId: 't1', subjectId: 'e' }, limit).admitted).toBe(false);
  });
});
