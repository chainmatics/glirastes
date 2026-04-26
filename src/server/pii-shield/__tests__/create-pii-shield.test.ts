import { describe, it, expect } from 'vitest';
import { createPiiShield } from '../create-pii-shield.js';
import type { PiiDetector, PiiEntity, PiiShield } from '../../../types.js';

// Mock detector: finds "Max Müller" and "max@test.com" in text
const mockDetector: PiiDetector = {
  detect(text: string): PiiEntity[] {
    const entities: PiiEntity[] = [];
    let idx = text.indexOf('Max Müller');
    if (idx !== -1) {
      entities.push({ type: 'person', start: idx, end: idx + 10, score: 1.0, text: 'Max Müller' });
    }
    idx = text.indexOf('max@test.com');
    if (idx !== -1) {
      entities.push({ type: 'email', start: idx, end: idx + 12, score: 1.0, text: 'max@test.com' });
    }
    return entities;
  },
};

describe('createPiiShield', () => {
  const sessionId = 'test-session-1';

  it('creates a shield instance', () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    expect(shield).toBeDefined();
    expect(shield.outbound).toBeTypeOf('function');
    expect(shield.inbound).toBeTypeOf('function');
    expect(shield.rehydrateArgs).toBeTypeOf('function');
    expect(shield.anonymizeResult).toBeTypeOf('function');
    expect(shield.getComplianceSummary).toBeTypeOf('function');
    expect(shield.clearSession).toBeTypeOf('function');
  });

  it('outbound: pseudonymizes detected PII', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    const result = await shield.outbound('Hallo Max Müller, deine Email ist max@test.com', sessionId);
    expect(result).not.toContain('Max Müller');
    expect(result).not.toContain('max@test.com');
    expect(result).toContain('Hallo');
    expect(result).toContain('deine Email ist');
  });

  it('inbound: de-pseudonymizes back to original', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    const pseudonymized = await shield.outbound('Hallo Max Müller', sessionId);
    const restored = shield.inbound(pseudonymized, sessionId);
    expect(restored).toContain('Max Müller');
  });

  it('rehydrateArgs: replaces pseudonyms with originals in tool args', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    const pseudonymized = await shield.outbound('Schicke Email an Max Müller (max@test.com)', sessionId);

    // Extract pseudonyms from the output
    const pseudonymName = pseudonymized.match(/Schicke Email an (.+?) \(/)?.[1] ?? '';
    const pseudonymEmail = pseudonymized.match(/\((.+?)\)/)?.[1] ?? '';

    const args = { recipient: pseudonymName, email: pseudonymEmail };
    const rehydrated = shield.rehydrateArgs(args, sessionId);
    expect(rehydrated.recipient).toBe('Max Müller');
    expect(rehydrated.email).toBe('max@test.com');
  });

  it('anonymizeResult: pseudonymizes PII in tool results', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    await shield.outbound('Find Max Müller', sessionId);

    const toolResult = { user: { name: 'Max Müller', email: 'max@test.com' } };
    const anonymized = await shield.anonymizeResult(toolResult, sessionId);
    const result = anonymized as { user: { name: string; email: string } };
    expect(result.user.name).not.toBe('Max Müller');
    expect(result.user.email).not.toBe('max@test.com');
  });

  it('full roundtrip: outbound → rehydrateArgs → anonymizeResult → inbound', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });

    // 1. User message pseudonymized
    const outbound = await shield.outbound('Erstelle Aufgabe für Max Müller (max@test.com)', sessionId);
    expect(outbound).not.toContain('Max Müller');

    // 2. LLM calls tool with pseudonym args — rehydrate to real
    const pseudonymName = outbound.match(/Erstelle Aufgabe für (.+?) \(/)?.[1] ?? '';
    const rehydrated = shield.rehydrateArgs({ assignee: pseudonymName }, sessionId);
    expect(rehydrated.assignee).toBe('Max Müller');

    // 3. Tool returns real data — anonymize before LLM sees it
    const toolResult = { created: true, assignee: 'Max Müller' };
    const anonymizedResult = await shield.anonymizeResult(toolResult, sessionId);
    expect((anonymizedResult as any).assignee).not.toBe('Max Müller');

    // 4. LLM response with pseudonyms — de-pseudonymize for user
    const llmResponse = `Aufgabe wurde ${(anonymizedResult as any).assignee} zugewiesen.`;
    const final = shield.inbound(llmResponse, sessionId);
    expect(final).toContain('Max Müller');
  });

  it('getComplianceSummary: returns session stats', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    await shield.outbound('Hallo Max Müller', sessionId);
    const summary = shield.getComplianceSummary(sessionId);
    expect(summary.sessionId).toBe(sessionId);
    expect(summary.mode).toBe('pseudonymize');
    expect(summary.totalMessages).toBe(1);
    expect(summary.piiStats.totalDetected).toBeGreaterThan(0);
    expect(summary.verdict).toBe('COMPLIANT');
  });

  it('clearSession: removes all mappings', async () => {
    const shield = createPiiShield({ locale: 'de', detector: mockDetector });
    const out = await shield.outbound('Hallo Max Müller', sessionId);
    shield.clearSession(sessionId);
    const result = shield.inbound(out, sessionId);
    expect(result).not.toContain('Max Müller');
  });

  it('onAudit callback fires on outbound', async () => {
    const audits: any[] = [];
    const shield = createPiiShield({
      locale: 'de',
      detector: mockDetector,
      onAudit: (entry) => audits.push(entry),
    });
    await shield.outbound('Hallo Max Müller', sessionId);
    expect(audits).toHaveLength(1);
    expect(audits[0].direction).toBe('outbound');
    expect(audits[0].totalDetected).toBe(1);
    expect(audits[0].mode).toBe('pseudonymize');
  });

  it('leakage detection: flags originals in LLM output', async () => {
    const audits: any[] = [];
    const shield = createPiiShield({
      locale: 'de',
      detector: mockDetector,
      leakageDetection: true,
      onAudit: (entry) => audits.push(entry),
    });
    await shield.outbound('Hallo Max Müller', sessionId);
    shield.inbound('The real name is Max Müller', sessionId);
    const leakAudit = audits.find((a) => a.direction === 'inbound' && a.leakage);
    expect(leakAudit).toBeDefined();
  });

  it('works with async detector', async () => {
    const asyncDetector: PiiDetector = {
      async detect(text: string): Promise<PiiEntity[]> {
        const idx = text.indexOf('Max Müller');
        if (idx === -1) return [];
        return [{ type: 'person', start: idx, end: idx + 10, score: 1.0, text: 'Max Müller' }];
      },
    };
    const shield = createPiiShield({ locale: 'de', detector: asyncDetector });
    const result = await shield.outbound('Hallo Max Müller', sessionId);
    expect(result).not.toContain('Max Müller');
  });
});
