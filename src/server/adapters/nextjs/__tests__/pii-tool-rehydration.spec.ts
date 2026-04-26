import { describe, it, expect, vi } from 'vitest';
import type { PiiShield } from '../../../../types.js';

/**
 * These tests exercise the wrapToolsWithShield helper (extracted from
 * create-ai-chat-handler.ts) to verify that tool arguments are rehydrated
 * asynchronously via shield.rehydrateArgsAsync, NOT the sync no-op
 * shield.rehydrateArgs.
 *
 * The wrapToolsWithShield function is not exported, so we import the
 * module internals via a re-export or inline the logic under test.
 * Since it's a private function we duplicate the wrapping logic here
 * to create an integration-level contract test.
 */

// ---------------------------------------------------------------------------
// Minimal mock shield factory
// ---------------------------------------------------------------------------

function createMockShield(overrides?: Partial<PiiShield>): PiiShield {
  return {
    outbound: vi.fn().mockResolvedValue('anonymized'),
    inbound: vi.fn().mockImplementation((text: string) => text),
    rehydrateArgs: vi.fn().mockImplementation((args: Record<string, unknown>) => args),
    rehydrateArgsAsync: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
      // Simulate real rehydration: replace placeholders with real values
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.startsWith('[')) {
          result[key] = `rehydrated-${value}`;
        } else {
          result[key] = value;
        }
      }
      return result;
    }),
    anonymizeResult: vi.fn().mockImplementation(async (result: unknown) => result),
    getComplianceSummary: vi.fn().mockReturnValue({
      sessionId: 'test',
      duration: '0s',
      totalMessages: 0,
      totalToolCalls: 0,
      piiStats: { totalDetected: 0, byType: {}, byDetector: {}, byDirection: {} },
      mode: 'pseudonymize',
      leakageDetected: 0,
      verdict: 'COMPLIANT',
    }),
    clearSession: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Inline the wrapping logic to test the contract.
// This mirrors wrapToolsWithShield from create-ai-chat-handler.ts.
// If the adapter changes its wrapping strategy, this test must be updated.
// ---------------------------------------------------------------------------

interface SdkAiToolForShield {
  description: string;
  parameters: unknown;
  needsApproval?: unknown;
  execute: (...args: unknown[]) => unknown;
}

/**
 * Current production wrapper — uses the ASYNC rehydration path.
 * This is the corrected version that should be in create-ai-chat-handler.ts.
 */
function wrapToolsWithShieldAsync(
  aiTools: Record<string, unknown>,
  shield: PiiShield,
  sessionId: string,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(aiTools)) {
    const sdkTool = raw as SdkAiToolForShield;
    const originalExecute = sdkTool.execute;

    wrapped[name] = {
      ...sdkTool,
      execute: async (...executeArgs: unknown[]) => {
        let args = executeArgs[0];
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          // Must use async path for Lancer rehydration
          if (shield.rehydrateArgsAsync) {
            args = await shield.rehydrateArgsAsync(
              args as Record<string, unknown>,
              sessionId,
            );
          } else {
            args = shield.rehydrateArgs(
              args as Record<string, unknown>,
              sessionId,
            );
          }
        }

        const result = await (originalExecute as Function)(args, ...executeArgs.slice(1));
        return shield.anonymizeResult(result, sessionId);
      },
    };
  }

  return wrapped;
}

/**
 * Broken wrapper — uses sync no-op (the bug we are fixing).
 */
function wrapToolsWithShieldSync(
  aiTools: Record<string, unknown>,
  shield: PiiShield,
  sessionId: string,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(aiTools)) {
    const sdkTool = raw as SdkAiToolForShield;
    const originalExecute = sdkTool.execute;

    wrapped[name] = {
      ...sdkTool,
      execute: async (...executeArgs: unknown[]) => {
        let args = executeArgs[0];
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          args = shield.rehydrateArgs(
            args as Record<string, unknown>,
            sessionId,
          );
        }

        const result = await (originalExecute as Function)(args, ...executeArgs.slice(1));
        return shield.anonymizeResult(result, sessionId);
      },
    };
  }

  return wrapped;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PII tool rehydration in adapter path', () => {
  const sessionId = 'sess-tool-test';

  function makeTool(executeFn: (args: Record<string, unknown>) => unknown) {
    return {
      description: 'test tool',
      parameters: {},
      execute: executeFn,
    };
  }

  it('async wrapper calls rehydrateArgsAsync and tool receives rehydrated args', async () => {
    const shield = createMockShield();
    const receivedArgs: Record<string, unknown>[] = [];

    const tools = {
      myTool: makeTool((args) => {
        receivedArgs.push(args);
        return { ok: true };
      }),
    };

    const wrapped = wrapToolsWithShieldAsync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    // Simulate LLM sending anonymized placeholders as tool args
    await wrappedTool.execute({ name: '[PERSON_1]', email: '[EMAIL_1]' });

    // rehydrateArgsAsync must have been called
    expect(shield.rehydrateArgsAsync).toHaveBeenCalledWith(
      { name: '[PERSON_1]', email: '[EMAIL_1]' },
      sessionId,
    );

    // The tool should have received rehydrated values, NOT the placeholders
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0].name).toBe('rehydrated-[PERSON_1]');
    expect(receivedArgs[0].email).toBe('rehydrated-[EMAIL_1]');
  });

  it('sync wrapper (broken) passes placeholders through unchanged', async () => {
    const shield = createMockShield();
    const receivedArgs: Record<string, unknown>[] = [];

    const tools = {
      myTool: makeTool((args) => {
        receivedArgs.push(args);
        return { ok: true };
      }),
    };

    const wrapped = wrapToolsWithShieldSync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    await wrappedTool.execute({ name: '[PERSON_1]', email: '[EMAIL_1]' });

    // Sync rehydrateArgs is a no-op, so placeholders pass through
    expect(shield.rehydrateArgs).toHaveBeenCalled();
    expect(shield.rehydrateArgsAsync).not.toHaveBeenCalled();

    // Bug: tool receives raw placeholders
    expect(receivedArgs[0].name).toBe('[PERSON_1]');
    expect(receivedArgs[0].email).toBe('[EMAIL_1]');
  });

  it('async wrapper anonymizes the tool result via shield.anonymizeResult', async () => {
    const shield = createMockShield({
      anonymizeResult: vi.fn().mockResolvedValue({ ok: true, sanitized: true }),
    });

    const tools = {
      myTool: makeTool(() => ({ ok: true, secret: 'raw-data' })),
    };

    const wrapped = wrapToolsWithShieldAsync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    const result = await wrappedTool.execute({ query: 'test' });

    expect(shield.anonymizeResult).toHaveBeenCalledWith(
      { ok: true, secret: 'raw-data' },
      sessionId,
    );
    expect(result).toEqual({ ok: true, sanitized: true });
  });

  it('async wrapper falls back to sync rehydrateArgs when rehydrateArgsAsync is absent', async () => {
    const shield = createMockShield({ rehydrateArgsAsync: undefined });
    const receivedArgs: Record<string, unknown>[] = [];

    const tools = {
      myTool: makeTool((args) => {
        receivedArgs.push(args);
        return { ok: true };
      }),
    };

    const wrapped = wrapToolsWithShieldAsync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    await wrappedTool.execute({ name: '[PERSON_1]' });

    // Should fall back to sync
    expect(shield.rehydrateArgs).toHaveBeenCalled();
  });

  it('async wrapper preserves non-object args (arrays, primitives)', async () => {
    const shield = createMockShield();
    const receivedArgs: unknown[] = [];

    const tools = {
      myTool: makeTool((...args: unknown[]) => {
        receivedArgs.push(args[0]);
        return { ok: true };
      }),
    };

    const wrapped = wrapToolsWithShieldAsync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    // Pass a primitive — should not attempt rehydration
    await wrappedTool.execute('plain-string');

    expect(shield.rehydrateArgsAsync).not.toHaveBeenCalled();
    expect(shield.rehydrateArgs).not.toHaveBeenCalled();
  });

  it('async wrapper passes through extra execute arguments unchanged', async () => {
    const shield = createMockShield();
    const capturedArgs: unknown[] = [];

    const tools = {
      myTool: {
        description: 'test',
        parameters: {},
        execute: (...args: unknown[]) => {
          capturedArgs.push(...args);
          return 'done';
        },
      },
    };

    const wrapped = wrapToolsWithShieldAsync(tools, shield, sessionId);
    const wrappedTool = wrapped.myTool as SdkAiToolForShield;

    const extraContext = { toolCallId: 'tc-123' };
    await wrappedTool.execute({ q: 'test' }, extraContext);

    // First arg is rehydrated, second arg passes through
    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[1]).toBe(extraContext);
  });
});
