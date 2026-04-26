import { describe, it, expect, expectTypeOf } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import type { PiiShield, PiiDetector } from '../../../types.js';

const noopDetector: PiiDetector = {
  detect: () => [],
};

describe('adapter-nextjs compatibility', () => {
  it('returns an object satisfying PiiShield interface', () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    expectTypeOf(shield).toMatchTypeOf<PiiShield>();
    expect(shield.outbound).toBeTypeOf('function');
    expect(shield.inbound).toBeTypeOf('function');
    expect(shield.rehydrateArgs).toBeTypeOf('function');
    expect(shield.anonymizeResult).toBeTypeOf('function');
    expect(shield.getComplianceSummary).toBeTypeOf('function');
    expect(shield.clearSession).toBeTypeOf('function');
  });

  it('outbound returns a Promise<string>', async () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    const result = shield.outbound('test', 'session');
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe('test');
  });

  it('inbound returns a string (sync)', () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    const result = shield.inbound('test', 'session');
    expect(typeof result).toBe('string');
  });

  it('rehydrateArgs returns Record<string, unknown> (sync)', () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    const result = shield.rehydrateArgs({ a: 1 }, 'session');
    expect(typeof result).toBe('object');
  });

  it('anonymizeResult returns Promise<unknown>', async () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    const result = shield.anonymizeResult({ a: 1 }, 'session');
    expect(result).toBeInstanceOf(Promise);
  });

  it('works with no PII detected (passthrough)', async () => {
    const shield = createPiiShield({ locale: 'de', detector: noopDetector });
    const text = 'Hallo Welt, keine PII hier.';
    const out = await shield.outbound(text, 'session');
    expect(out).toBe(text);
    const back = shield.inbound(out, 'session');
    expect(back).toBe(text);
  });
});
