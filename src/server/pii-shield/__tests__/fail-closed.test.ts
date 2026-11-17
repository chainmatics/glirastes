import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import type { PiiDetector } from '../../../types.js';
import { createAegisDetector } from '../aegis-detector.js';
import { detectStrict, isPrivacyError, PrivacyError, toSafeError } from '../detection-result.js';
import { createMemoryPrivacyMappingStore, type PrivacyMappingStore } from '../mapping-store.js';
import { createPrivacyBoundary } from '../model-boundary.js';
import { createStrictPiiShield } from '../strict-shield.js';
import { CANARY, CANARY_PATTERN, captureModel, memoryShield, testScope } from './privacy-fixtures.js';

const throwing: PiiDetector = { detect: () => { throw new Error(`detector saw ${CANARY.email}`); } };
const hanging: PiiDetector = { detect: () => new Promise(() => undefined) };
const malformed: PiiDetector = { detect: async () => [{ type: 'email', start: 0, end: 999, text: 'x', score: 1 }] };
const shifted: PiiDetector = { detect: async (text) => [{ type: 'email', start: 1, end: 5, text: text.slice(0, 4), score: 1 }] };
const notArray: PiiDetector = { detect: async () => ({ entities: [] }) as never };

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(isPrivacyError(error)).toBe(true);
  expect((error as PrivacyError).code).toBe(code);
  expect(String((error as Error).message)).not.toMatch(CANARY_PATTERN);
  expect(JSON.stringify(error)).not.toMatch(CANARY_PATTERN);
  return error as PrivacyError;
}

describe('strict detection', () => {
  it.each([
    ['throws', throwing, 'privacy_detector_unavailable'],
    ['times out', hanging, 'privacy_detector_unavailable'],
    ['returns an out-of-range offset', malformed, 'privacy_detector_invalid_result'],
    ['returns text that does not match its offsets', shifted, 'privacy_detector_invalid_result'],
    ['returns a non-array', notArray, 'privacy_detector_invalid_result'],
  ])('a detector that %s is unavailable, never clean', async (_label, detector, code) => {
    const result = await detectStrict(detector, `Mail an ${CANARY.email}`, ['de'], { deadlineMs: 50 });
    expect(result).toEqual({ status: 'unavailable', code });
  });

  it('an aborted signal is unavailable', async () => {
    const controller = new AbortController();
    const pending = detectStrict(hanging, 'x', ['de'], { deadlineMs: 5_000, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', code: 'privacy_detector_unavailable' });
  });

  it('zero entities from a successful run is ok', async () => {
    const result = await detectStrict({ detect: async () => [] }, 'Hallo', ['de']);
    expect(result).toEqual({ status: 'ok', entities: [] });
  });
});

describe('strict shield construction and session', () => {
  it('refuses a remote detector (legacy Aegis)', () => {
    const aegis = createAegisDetector({ analyze: async () => ({ entities: [] }) });
    expect(() => memoryShield({ detectors: [aegis] })).toThrow(PrivacyError);
    try {
      memoryShield({ detectors: [aegis] });
    } catch (error) {
      expect((error as PrivacyError).code).toBe('privacy_remote_detector_rejected');
    }
  });

  it('refuses a non-persistent store without the explicit test opt-in', () => {
    expect(() => createStrictPiiShield({ store: createMemoryPrivacyMappingStore(), locale: 'de-DE' })).toThrow(
      expect.objectContaining({ code: 'privacy_store_not_persistent' }),
    );
  });

  it('rejects a malformed scope before touching the store', async () => {
    let touched = false;
    const store: PrivacyMappingStore = {
      ...createMemoryPrivacyMappingStore(),
      load: async () => { touched = true; throw new Error('unreachable'); },
    };
    const shield = createStrictPiiShield({ store, locale: 'de-DE', allowEphemeralStore: true });
    await expectCode(shield.open(testScope({ principalId: '' })), 'privacy_scope_invalid');
    await expectCode(shield.open(testScope({ tenantId: 'a b' })), 'privacy_scope_invalid');
    expect(touched).toBe(false);
  });

  it('a store failure is privacy_mapping_unavailable-like and content-free', async () => {
    const base = createMemoryPrivacyMappingStore();
    const store: PrivacyMappingStore = {
      ...base,
      load: base.load,
      append: async () => { throw new PrivacyError('privacy_mapping_unavailable'); },
    };
    const shield = createStrictPiiShield({ store, locale: 'de-DE', allowEphemeralStore: true });
    const session = await shield.open(testScope());
    await expectCode(session.pseudonymizeText(`Schreib ${CANARY.email}`), 'privacy_mapping_unavailable');
  });

  it('a detector failure stops pseudonymization instead of passing the raw text', async () => {
    const shield = memoryShield({ detectors: [throwing] });
    const session = await shield.open(testScope());
    await expectCode(session.pseudonymizeText(`Schreib ${CANARY.email}`), 'privacy_detector_unavailable');
  });

  it('binary JSON content is blocked', async () => {
    const session = await memoryShield().open(testScope());
    await expectCode(session.pseudonymizeJson({ blob: new Uint8Array([1, 2, 3]) }), 'privacy_binary_content_blocked');
  });
});

describe('fail-closed model calls', () => {
  it('a detector failure never reaches the provider', async () => {
    const session = await memoryShield({ detectors: [throwing] }).open(testScope());
    const boundary = createPrivacyBoundary({ session });
    const { model, calls } = captureModel();
    await expectCode(
      generateText({ model: boundary.wrapModel(model), prompt: `Schreib an ${CANARY.email}`, maxRetries: 0 }),
      'privacy_detector_unavailable',
    );
    expect(calls).toHaveLength(0);
  });

  it('a mapping failure never reaches the provider', async () => {
    const store: PrivacyMappingStore = {
      ...createMemoryPrivacyMappingStore(),
      append: async () => { throw new PrivacyError('privacy_mapping_unavailable'); },
    };
    const base = createMemoryPrivacyMappingStore();
    store.load = base.load;
    const session = await createStrictPiiShield({ store, locale: 'de-DE', allowEphemeralStore: true }).open(testScope());
    const { model, calls } = captureModel();
    await expectCode(
      generateText({ model: createPrivacyBoundary({ session }).wrapModel(model), prompt: `Mail ${CANARY.email}`, maxRetries: 0 }),
      'privacy_mapping_unavailable',
    );
    expect(calls).toHaveLength(0);
  });

  it('a blocked provider option never reaches the provider', async () => {
    const session = await memoryShield().open(testScope());
    const { model, calls } = captureModel();
    await expectCode(
      generateText({
        model: createPrivacyBoundary({ session }).wrapModel(model),
        prompt: 'Hallo',
        providerOptions: { openai: { user: CANARY.email } },
        maxRetries: 0,
      }),
      'privacy_provider_option_blocked',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('safe error summaries', () => {
  it('reduces any error to name and code without its message', () => {
    expect(toSafeError(new Error(`failed for ${CANARY.email}`))).toEqual({ name: 'Error', code: 'unknown_error' });
    expect(toSafeError(new PrivacyError('privacy_output_leak'))).toEqual({ name: 'PrivacyError', code: 'privacy_output_leak' });
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(toSafeError(abort).code).toBe('aborted');
  });

  it('a PrivacyError serializes without content', () => {
    const error = new PrivacyError('privacy_detector_unavailable');
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'PrivacyError', code: 'privacy_detector_unavailable' });
  });
});
