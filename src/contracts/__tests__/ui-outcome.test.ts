import { describe, expect, expectTypeOf, it } from 'vitest';
import type { UiOutcomeCode as BrowserUiOutcomeCode } from '../../browser/index.js';
import {
  isUiOutcomeCode,
  MAX_UI_OUTCOME_CONTINUATIONS,
  readUiOutcomeCode,
  UI_OUTCOME_MODEL_TEXTS,
  UI_OUTCOMES_REQUEST_FIELD,
  uiOutcomeModelResult,
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

  it('has one fixed model text per code and for "not confirmed", each closing the same way', () => {
    expect(Object.keys(UI_OUTCOME_MODEL_TEXTS).sort()).toEqual([...UI_OUTCOME_CODES, 'unconfirmed'].sort());
    for (const text of Object.values(UI_OUTCOME_MODEL_TEXTS)) expect(text.endsWith('Do not quote this text.')).toBe(true);
    expect(UI_OUTCOME_MODEL_TEXTS.unconfirmed).toContain('it will not be carried out later');
  });

  it('maps an outcome to its model result: success only where the app said what happened', () => {
    expect(uiOutcomeModelResult({ v: 1, code: 'ok' })).toEqual({ success: true, message: UI_OUTCOME_MODEL_TEXTS.ok });
    expect(uiOutcomeModelResult({ v: 1, code: 'failed' })).toEqual({ success: false, message: UI_OUTCOME_MODEL_TEXTS.failed });
    expect(uiOutcomeModelResult({ v: 1, code: 'initiated', at: 5 })).toEqual({ message: UI_OUTCOME_MODEL_TEXTS.initiated });
    for (const unconfirmed of [undefined, { v: 1 }, { v: 2, code: 'ok' }, { v: 1, code: 'done' }, 'ok']) {
      expect(uiOutcomeModelResult(unconfirmed)).toEqual({ message: UI_OUTCOME_MODEL_TEXTS.unconfirmed });
    }
    expect(readUiOutcomeCode({ v: 1, code: 'unavailable' })).toBe('unavailable');
    expect(UI_OUTCOMES_REQUEST_FIELD).toBe('glirastesUiOutcomes');
    expect(MAX_UI_OUTCOME_CONTINUATIONS).toBe(3);
  });
});
