import { describe, expect, expectTypeOf, it } from 'vitest';
import type { UiOutcomeCode as BrowserUiOutcomeCode } from '../../browser/index.js';
import {
  isUiOutcomeCode,
  UI_OUTCOME_CODES,
  UI_OUTCOME_PROTOCOL_VERSION,
  UiOutcomeSchema,
  type UiOutcomeCode,
} from '../index.js';

describe('UI outcome contract v1', () => {
  it('has exactly the six v1 codes, including initiated', () => {
    expect(UI_OUTCOME_PROTOCOL_VERSION).toBe(1);
    expect([...UI_OUTCOME_CODES]).toEqual([
      'ok', 'rejected-contract', 'rejected-handler', 'unavailable', 'failed', 'initiated',
    ]);
    expect(isUiOutcomeCode('ok')).toBe(true);
    expect(isUiOutcomeCode('timeout')).toBe(false);
    expect(isUiOutcomeCode(undefined)).toBe(false);
  });

  it('has the same codes as the union glirastes/browser keeps for itself', () => {
    expectTypeOf<BrowserUiOutcomeCode>().toEqualTypeOf<UiOutcomeCode>();
  });

  it('accepts a code, no code (not confirmed) and a browser timestamp', () => {
    expect(UiOutcomeSchema.safeParse({ v: 1, code: 'ok' }).success).toBe(true);
    expect(UiOutcomeSchema.safeParse({ v: 1 }).success).toBe(true);
    expect(UiOutcomeSchema.safeParse({ v: 1, code: 'initiated', at: 1_700_000_000_000 }).success).toBe(true);
  });

  it('refuses other versions, unknown codes, extra fields and payloads', () => {
    expect(UiOutcomeSchema.safeParse({ v: 2, code: 'ok' }).success).toBe(false);
    expect(UiOutcomeSchema.safeParse({ v: 1, code: 'timeout' }).success).toBe(false);
    expect(UiOutcomeSchema.safeParse({ v: 1, code: 'ok', message: 'done' }).success).toBe(false);
    expect(UiOutcomeSchema.safeParse({ v: 1, at: -1 }).success).toBe(false);
  });
});
