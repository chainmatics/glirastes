import type {
  PiiCategory,
  PiiDetector,
  PiiEntity,
} from '../../types.js';

interface RegexPattern {
  type: PiiCategory;
  pattern: RegExp;
  score: number;
  validate?: (match: string) => boolean;
}

export interface RegexPiiDetectorConfig {
  categories?: PiiCategory[];
  customPatterns?: RegexPattern[];
}

const COMMON_PATTERNS: RegexPattern[] = [
  {
    type: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    score: 0.95,
  },
  {
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\s?[A-Z0-9]{0,2}\b/g,
    score: 0.9,
    validate: (match) => {
      const length = match.replace(/\s/g, '').length;
      return length >= 15 && length <= 34;
    },
  },
  {
    type: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    score: 0.7,
  },
  {
    type: 'url',
    pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
    score: 0.8,
  },
];

const GERMAN_PATTERNS: RegexPattern[] = [
  {
    type: 'phone',
    pattern: /(?:\+49|0049)[\s.-]?\(?\d{2,5}\)?[\s.-]?\d{3,10}(?:[\s.-]?\d{1,8})?/g,
    score: 0.8,
    validate: (match) => {
      const length = match.replace(/\D/g, '').length;
      return length >= 7 && length <= 15;
    },
  },
  {
    type: 'phone',
    pattern: /\b0\d{2,4}[\s/.-]\d{3,8}(?:[\s/.-]?\d{1,6})?\b/g,
    score: 0.7,
  },
  {
    type: 'date_of_birth',
    pattern: /\b(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g,
    score: 0.6,
  },
  {
    type: 'tax_id',
    pattern: /\b\d{2,3}\/\d{3,4}\/\d{4,5}\b/g,
    score: 0.6,
  },
  {
    type: 'address',
    pattern: /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+/g,
    score: 0.6,
  },
];

function deduplicate(entities: PiiEntity[]): PiiEntity[] {
  const sorted = [...entities].sort((left, right) => (
    left.start - right.start
    || right.score - left.score
    || (right.end - right.start) - (left.end - left.start)
  ));
  const result: PiiEntity[] = [];
  for (const entity of sorted) {
    const previous = result.at(-1);
    if (!previous || entity.start >= previous.end) {
      result.push(entity);
    }
  }
  return result;
}

export function createRegexPiiDetector(
  config: RegexPiiDetectorConfig = {},
): PiiDetector {
  return {
    detect(text, locales = []) {
      const locale = locales[0]?.split('-')[0]?.toLowerCase();
      let patterns = [
        ...COMMON_PATTERNS,
        ...(locale === 'de' ? GERMAN_PATTERNS : []),
        ...(config.customPatterns ?? []),
      ];
      if (config.categories?.length) {
        const allowed = new Set(config.categories);
        patterns = patterns.filter((pattern) => allowed.has(pattern.type));
      }

      const entities: PiiEntity[] = [];
      for (const definition of patterns) {
        const pattern = new RegExp(
          definition.pattern.source,
          definition.pattern.flags.includes('g')
            ? definition.pattern.flags
            : `${definition.pattern.flags}g`,
        );
        for (const match of text.matchAll(pattern)) {
          const value = match[0];
          const start = match.index;
          if (start === undefined || !value) continue;
          if (definition.validate && !definition.validate(value)) continue;
          entities.push({
            type: definition.type,
            start,
            end: start + value.length,
            score: definition.score,
            text: value,
          });
        }
      }
      return deduplicate(entities);
    },
  };
}
