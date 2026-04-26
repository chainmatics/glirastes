import { describe, it, expect } from 'vitest';
import { createAegisDetector } from '../aegis-detector.js';
import type { AegisLike } from '../aegis-detector.js';

describe('createAegisDetector', () => {
  const mockAegis: AegisLike = {
    async analyze(_text: string, _locales: string[]) {
      return {
        entities: [
          { type: 'person', start: 0, end: 10, value: 'Max Müller', confidence: 0.95 },
          { type: 'email', start: 12, end: 24, value: 'max@test.com' },
        ],
      };
    },
  };

  it('maps Aegis entities to PiiEntity format', async () => {
    const detector = createAegisDetector(mockAegis);
    const entities = await detector.detect('Max Müller max@test.com');
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({
      type: 'person',
      start: 0,
      end: 10,
      score: 0.95,
      text: 'Max Müller',
    });
    expect(entities[1]).toEqual({
      type: 'email',
      start: 12,
      end: 24,
      score: 1.0,
      text: 'max@test.com',
    });
  });

  it('passes locales to aegis.analyze', async () => {
    let capturedLocales: string[] = [];
    const spy: AegisLike = {
      async analyze(_text, locales) {
        capturedLocales = locales;
        return { entities: [] };
      },
    };
    const detector = createAegisDetector(spy);
    await detector.detect('test', ['de']);
    expect(capturedLocales).toEqual(['de']);
  });

  it('defaults to de+en when no locales provided', async () => {
    let capturedLocales: string[] = [];
    const spy: AegisLike = {
      async analyze(_text, locales) {
        capturedLocales = locales;
        return { entities: [] };
      },
    };
    const detector = createAegisDetector(spy);
    await detector.detect('test');
    expect(capturedLocales).toEqual(['de', 'en']);
  });
});
