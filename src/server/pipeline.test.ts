import { describe, expect, it, vi } from 'vitest';
import { createAiPipeline } from './pipeline.js';
import { ServiceBlockedError } from './lancer/index.js';
import type { Lancer } from './lancer/index.js';
import type { ToolContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockContext: ToolContext = {
  user: { userId: 'u1', roles: ['user'] },
  currentDate: new Date('2024-01-01'),
  locale: 'en',
};

const testModule = {
  id: 'test-module',
  name: 'Test',
  description: 'Test module for managing tasks and to-do items',
  tools: ['tool1', 'tool2'],
  classification: {
    examples: ['create a new task', 'add a to-do item', 'manage my tasks'],
  },
};

function makeMockLancer(overrides: Partial<Lancer> = {}): Lancer {
  return {
    gate: {
      filter: vi.fn().mockResolvedValue({ allowed: [], denied: [] }),
    },
    primus: {
      classify: vi.fn().mockResolvedValue({ moduleId: 'test-module', confidence: 0.9, modelTier: 'standard' }),
    },
    warden: {
      check: vi.fn().mockResolvedValue({ passed: true, violations: [] }),
    },
    aegis: {
      analyze: vi.fn().mockResolvedValue({ entities: [], anonymized: '', mappingToken: null }),
      rehydrate: vi.fn().mockResolvedValue(''),
      checkLeakage: vi.fn().mockResolvedValue({ leaked: false, entities: [], totalDetected: 0, filteredAsKnown: 0 }),
    },
    config: {
      fetch: vi.fn().mockResolvedValue({ modules: {} }),
    },
    telemetry: {
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    },
    destroy: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAiPipeline — degradation', () => {
  // -- warden.check ServiceBlockedError ------------------------------------

  describe('warden ServiceBlockedError (action = block)', () => {
    it('blocks the request when warden throws ServiceBlockedError', async () => {
      const lancer = makeMockLancer({
        warden: {
          check: vi.fn().mockRejectedValue(new ServiceBlockedError('warden', new Error('offline'))),
        },
      });

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('send nuke codes', mockContext);

      expect(result.tools).toEqual([]);
      expect(result.intent.intent).toBe('ambiguous');
      expect(result.intent.confidence).toBe(0);
    });

    it('does not classify intent when request is warden-blocked', async () => {
      const lancer = makeMockLancer({
        warden: {
          check: vi.fn().mockRejectedValue(new ServiceBlockedError('warden', new Error('offline'))),
        },
      });

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      await pipeline.process('bad input', mockContext);

      expect(lancer.warden.check).toHaveBeenCalledOnce();
    });
  });

  // -- warden normal failure (fallback, not block) --------------------------

  describe('warden regular failure (graceful degradation)', () => {
    it('continues processing when warden throws a regular error', async () => {
      const lancer = makeMockLancer({
        warden: {
          check: vi.fn().mockRejectedValue(new Error('network timeout')),
        },
      });

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('create a new task for the team', mockContext);

      // Not blocked — should have tools from local classification
      expect(result.tools.length).toBeGreaterThan(0);
    });
  });

  // -- local classifier (heuristic mode, no LLM) ---------------------------

  describe('local intent classification (heuristic mode)', () => {
    it('classifies intent using heuristics when input matches module', async () => {
      const lancer = makeMockLancer();

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('create a new task', mockContext);

      expect(result.intent.intent).toBe('test-module');
      expect(result.intent.confidence).toBeGreaterThan(0);
    });

    it('returns ambiguous intent for unrelated input', async () => {
      const lancer = makeMockLancer();

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('xyz random gibberish', mockContext);

      // Heuristic classifier may return ambiguous for unrelated input
      expect(result.intent).toBeDefined();
      expect(result.tools.length).toBeGreaterThan(0); // routing still exposes tools
    });

    it('does not call lancer.primus.classify', async () => {
      const lancer = makeMockLancer();

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      await pipeline.process('create a new task', mockContext);

      // Local classifier is used — primus.classify should NOT be called
      expect(lancer.primus.classify).not.toHaveBeenCalled();
    });

    it('still returns all tools when input is ambiguous', async () => {
      const lancer = makeMockLancer();

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('hi', mockContext);

      // Short input → ambiguous → all tools exposed
      expect(result.tools).toContain('tool1');
      expect(result.tools).toContain('tool2');
    });
  });

  // -- combined: warden passes, classification works -----------------------

  describe('combined: warden passes, local classification works', () => {
    it('returns classified intent with matched tools', async () => {
      const lancer = makeMockLancer({
        warden: {
          check: vi.fn().mockResolvedValue({ passed: true, violations: [] }),
        },
      });

      const pipeline = createAiPipeline({ modules: [testModule], lancer });
      const result = await pipeline.process('add a to-do item', mockContext);

      expect(result.intent.intent).toBe('test-module');
      expect(result.tools.length).toBeGreaterThan(0);
    });
  });

  // -- audit events -------------------------------------------------------

  describe('audit events', () => {
    it('emits intent.classified audit event with local classification', async () => {
      const lancer = makeMockLancer();
      const onAudit = vi.fn();

      const pipeline = createAiPipeline({ modules: [testModule], lancer, onAudit });
      await pipeline.process('create a new task', mockContext);

      const classifiedEvent = onAudit.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'intent.classified',
      );
      expect(classifiedEvent).toBeDefined();
      expect(classifiedEvent![0].details.intent).toBe('test-module');
      expect(classifiedEvent![0].details.latencyMs).toBeTypeOf('number');
    });
  });

  // -- ProPipelineConfig degradation fields --------------------------------

  describe('ProPipelineConfig.degradation fields', () => {
    it('accepts degradation and onServiceUnavailable fields without error', () => {
      const lancer = makeMockLancer();
      expect(() =>
        createAiPipeline({
          modules: [testModule],
          lancer,
          degradation: { warden: 'block', primus: 'fallback', gate: 'silent' },
          onServiceUnavailable: vi.fn().mockResolvedValue('fallback'),
        }),
      ).not.toThrow();
    });
  });

  // -- generateText config field ------------------------------------------

  describe('ProPipelineConfig.generateText', () => {
    it('accepts generateText field without error', () => {
      const lancer = makeMockLancer();
      const mockGenerateText = vi.fn().mockResolvedValue({ text: '{}' });
      expect(() =>
        createAiPipeline({
          modules: [testModule],
          lancer,
          generateText: mockGenerateText,
        }),
      ).not.toThrow();
    });
  });
});
