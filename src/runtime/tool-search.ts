import { newStemmer, type Stemmer } from 'snowball-stemmers';

/**
 * Searchable, content-bounded tool facts. Discovery builds these from the
 * pinned manifest or the deployed registry; nothing here grants access.
 */
export interface ToolSearchDocument {
  readonly name: string;
  readonly description: string;
  readonly module?: string;
  readonly sharedWith?: ReadonlyArray<string>;
  readonly usageHints?: ReadonlyArray<string>;
  readonly synonyms?: ReadonlyArray<string>;
}

export interface ToolSearchIndex {
  /** Document names ordered by relevance; empty when no query term matches. */
  search(query: string, limit: number): ReadonlyArray<string>;
}

const STEMMERS: ReadonlyArray<Stemmer> = [
  newStemmer('german'),
  newStemmer('english'),
];

/** Folded (lower-case, no diacritics, ß → ss) German and English function words. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can',
  'could', 'do', 'does', 'for', 'from', 'get', 'give', 'how', 'in', 'into',
  'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'show', 'some',
  'that', 'the', 'these', 'this', 'those', 'to', 'we', 'what', 'which',
  'who', 'with', 'would', 'you', 'your',
  'alle', 'allen', 'als', 'am', 'auch', 'auf', 'aus', 'bei', 'bitte', 'das',
  'dass', 'dem', 'den', 'der', 'des', 'die', 'dies', 'diese', 'diesem',
  'diesen', 'dieser', 'dieses', 'du', 'ein', 'eine', 'einem', 'einen',
  'einer', 'eines', 'es', 'fur', 'gib', 'habe', 'haben', 'hat', 'ich',
  'ihr', 'im', 'ist', 'kann', 'kannst', 'mal', 'man', 'mein', 'meine',
  'meinem', 'meinen', 'meiner', 'meines', 'mich', 'mir', 'mit', 'nach',
  'noch', 'oder', 'sind', 'uber', 'und', 'uns', 'unser', 'unsere', 'vom',
  'von', 'was', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wir', 'wo',
  'zu', 'zum', 'zur',
]);

const MIN_TOKEN_LENGTH = 2;
const MIN_PREFIX_LENGTH = 5;
const FIELD_WEIGHTS = {
  name: 8,
  synonyms: 6,
  description: 4,
  module: 3,
  hints: 2,
} as const;
type SearchField = keyof typeof FIELD_WEIGHTS;
const SEARCH_FIELDS = Object.keys(FIELD_WEIGHTS) as SearchField[];

/**
 * Unicode-aware tokens: camelCase and snake/dot names split, letters and
 * digits of every script kept, German/English diacritics folded, function
 * words dropped.
 */
export function searchTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) =>
      token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token));
}

function termVariants(token: string): ReadonlyArray<string> {
  const variants = new Set<string>([token]);
  for (const stemmer of STEMMERS) {
    const stem = stemmer.stem(token);
    if (stem.length >= MIN_TOKEN_LENGTH) variants.add(stem);
  }
  return [...variants];
}

/** Each query token with its German and English Snowball stems. */
export function searchTermVariants(
  text: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return searchTokens(text).map(termVariants);
}

function fieldVariants(text: string): ReadonlySet<string> {
  const variants = new Set<string>();
  for (const term of searchTermVariants(text)) {
    for (const variant of term) variants.add(variant);
  }
  return variants;
}

/** 1 for an exact token/stem hit, 0.5 for a compound prefix, else 0. */
function matchStrength(
  term: ReadonlyArray<string>,
  field: ReadonlySet<string>,
): number {
  for (const variant of term) if (field.has(variant)) return 1;
  for (const variant of term) {
    if (variant.length < MIN_PREFIX_LENGTH) continue;
    for (const candidate of field) {
      if (candidate.length < MIN_PREFIX_LENGTH) continue;
      if (candidate.startsWith(variant) || variant.startsWith(candidate)) {
        return 0.5;
      }
    }
  }
  return 0;
}

interface IndexedDocument {
  readonly name: string;
  readonly normalizedName: string;
  readonly fields: Readonly<Record<SearchField, ReadonlySet<string>>>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
  return {
    name: document.name,
    normalizedName: searchTokens(document.name).join(' '),
    fields: {
      name: fieldVariants(document.name),
      synonyms: fieldVariants((document.synonyms ?? []).join(' ')),
      description: fieldVariants(document.description),
      module: fieldVariants(
        [document.module, ...(document.sharedWith ?? [])]
          .filter((value): value is string => Boolean(value))
          .join(' '),
      ),
      hints: fieldVariants((document.usageHints ?? []).join(' ')),
    },
  };
}

/**
 * Builds a deterministic relevance index. Ranking: exact name, then the sum
 * over query terms of the best field hit (name > synonyms > description >
 * module > hints) weighted by inverse document frequency, then name.
 * No embeddings, network or model call.
 */
export function createToolSearchIndex(
  documents: ReadonlyArray<ToolSearchDocument>,
): ToolSearchIndex {
  const indexed = documents.map(indexDocument);

  const documentFrequency = (term: ReadonlyArray<string>) =>
    indexed.filter((document) =>
      SEARCH_FIELDS.some((field) =>
        matchStrength(term, document.fields[field]) > 0)).length;

  return Object.freeze({
    search(query: string, limit: number) {
      const terms = searchTermVariants(query);
      if (terms.length === 0 || indexed.length === 0) return Object.freeze([]);
      const inverseFrequency = terms.map((term) =>
        Math.log(1 + indexed.length / Math.max(1, documentFrequency(term))));
      const normalizedQuery = searchTokens(query).join(' ');

      const ranked = indexed
        .map((document) => {
          let score = 0;
          terms.forEach((term, index) => {
            let best = 0;
            for (const field of SEARCH_FIELDS) {
              best = Math.max(
                best,
                matchStrength(term, document.fields[field]) * FIELD_WEIGHTS[field],
              );
            }
            score += best * inverseFrequency[index]!;
          });
          return {
            name: document.name,
            exact: normalizedQuery === document.normalizedName ? 1 : 0,
            score,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) =>
          right.exact - left.exact
          || right.score - left.score
          || left.name.localeCompare(right.name))
        .slice(0, Math.max(0, Math.trunc(limit)))
        .map((candidate) => candidate.name);
      return Object.freeze(ranked);
    },
  });
}
