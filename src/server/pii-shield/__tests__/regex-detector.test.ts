import { describe, expect, it } from 'vitest';
import { createRegexPiiDetector } from '../regex-detector.js';

describe('createRegexPiiDetector', () => {
  it('detects common and German PII entirely locally', async () => {
    const detector = createRegexPiiDetector();
    const text = [
      'Mail: max@example.com',
      'Telefon: +49 30 12345678',
      'IBAN: DE89 3704 0044 0532 0130 00',
    ].join(', ');

    const entities = await detector.detect(text, ['de-DE']);

    expect(entities.map((entity) => entity.type)).toEqual([
      'email',
      'phone',
      'iban',
    ]);
    expect(entities.every((entity) => text.slice(entity.start, entity.end) === entity.text))
      .toBe(true);
  });

  it('deduplicates overlapping matches and supports category scoping', async () => {
    const detector = createRegexPiiDetector({ categories: ['email'] });

    const entities = await detector.detect(
      'max@example.com und +49 30 12345678',
      ['de'],
    );

    expect(entities).toHaveLength(1);
    expect(entities[0]?.type).toBe('email');
  });
});
