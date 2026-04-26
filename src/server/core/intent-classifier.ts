import type {
  IntentClassifier,
  IntentClassifierConfig,
  IntentClassification,
  ModuleDefinition,
  ToolContext,
  ConversationMessage,
} from '../../types.js';
import { newStemmer, algorithms, type Stemmer } from 'snowball-stemmers';

// ============================================================================
// Local Classifier Config
// ============================================================================

/**
 * Configuration for the local intent classifier.
 *
 * Extends IntentClassifierConfig with a `generateText` callback so
 * consumers can pass in their AI SDK `generateText` function without
 * the server-core package needing a hard dependency on `ai`.
 */
export interface LocalClassifierConfig extends IntentClassifierConfig {
  /**
   * Optional generateText callback (from Vercel AI SDK or compatible).
   * When provided, the classifier uses LLM classification with a
   * Jaccard heuristic fallback. Without it, only heuristics are used.
   *
   * Expected signature:
   * ```ts
   * (options: { model: unknown; prompt: string; }) => Promise<{ text: string }>
   * ```
   */
  generateText?: (options: {
    model: unknown;
    prompt: string;
    abortSignal?: AbortSignal;
  }) => Promise<{ text: string }>;
}

// ============================================================================
// Locale → Snowball Stemmer
// ============================================================================

const AVAILABLE_ALGOS = new Set(algorithms());

const LOCALE_MAP: Record<string, string> = {
  ar: 'arabic', am: 'armenian', eu: 'basque', ca: 'catalan', cs: 'czech',
  da: 'danish', nl: 'dutch', en: 'english', fi: 'finnish', fr: 'french',
  de: 'german', hu: 'hungarian', it: 'italian', ga: 'irish', nb: 'norwegian',
  nn: 'norwegian', no: 'norwegian', pt: 'portuguese', ro: 'romanian',
  ru: 'russian', es: 'spanish', sl: 'slovene', sv: 'swedish', ta: 'tamil',
  tr: 'turkish',
};

/** Resolve a BCP-47 locale (e.g. "de-DE") to a Snowball Stemmer, or null */
export function stemmerForLocale(locale?: string): Stemmer | null {
  if (!locale) return null;
  const lang = locale.split(/[-_]/)[0].toLowerCase();
  const algo = LOCALE_MAP[lang];
  if (algo && AVAILABLE_ALGOS.has(algo)) return newStemmer(algo);
  return null;
}

// ============================================================================
// Tokenization & Similarity
// ============================================================================

/**
 * Tokenize text into lowercase tokens (3+ chars).
 * Strips punctuation and splits on whitespace.
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3),
  );
}

function rawTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function toSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function stemTokens(tokens: string[], stemmer: Stemmer | null): Set<string> {
  if (!stemmer) return toSet(tokens);
  return toSet(tokens.map((t) => stemmer.stem(t)));
}

/** Character trigrams for fuzzy matching */
export function charTrigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const grams = new Set<string>();
  for (let i = 0; i <= clean.length - 3; i++) {
    grams.add(clean.slice(i, i + 3));
  }
  return grams;
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0 when either set is empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Count token pairs sharing a prefix of at least `minLen` chars */
export function prefixOverlap(a: Set<string>, b: Set<string>, minLen = 4): number {
  if (a.size === 0 || b.size === 0) return 0;
  const bArr = [...b];
  let matches = 0;
  const used = new Set<number>();
  for (const tokA of a) {
    if (tokA.length < minLen) continue;
    const pre = tokA.slice(0, minLen);
    for (let j = 0; j < bArr.length; j++) {
      if (used.has(j) || bArr[j].length < minLen) continue;
      if (bArr[j].startsWith(pre)) {
        matches++;
        used.add(j);
        break;
      }
    }
  }
  const union = a.size + b.size - matches;
  return union === 0 ? 0 : matches / union;
}

// ============================================================================
// Multi-Signal Heuristic Classifier
// ============================================================================

function scoreModule(
  inputTokens: Set<string>,
  inputStems: Set<string>,
  inputTrigrams: Set<string>,
  m: ModuleDefinition,
  stemmer: Stemmer | null,
): number {
  const descRaw = rawTokenize(m.description);
  const descTokens = toSet(descRaw);
  const descStems = stemTokens(descRaw, stemmer);
  const descTrigrams = charTrigrams(m.description);
  const examples = m.classification?.examples ?? [];

  // --- Signal 1: Stemmed Jaccard (handles inflection via Snowball) ---
  let bestStemEx = 0;
  for (const ex of examples) {
    const exRaw = rawTokenize(ex);
    bestStemEx = Math.max(bestStemEx, jaccardSimilarity(inputStems, stemTokens(exRaw, stemmer)));
  }
  const stemmedScore = Math.max(bestStemEx, jaccardSimilarity(inputStems, descStems) * 0.8);

  // --- Signal 2: Prefix overlap (morphological variants beyond stemmer) ---
  let bestPrefixEx = 0;
  for (const ex of examples) {
    bestPrefixEx = Math.max(bestPrefixEx, prefixOverlap(inputTokens, toSet(rawTokenize(ex))));
  }
  const prefixScore = Math.max(bestPrefixEx, prefixOverlap(inputTokens, descTokens) * 0.8);

  // --- Signal 3: Character trigrams (typos, partial matches) ---
  let bestTrigramEx = 0;
  for (const ex of examples) {
    bestTrigramEx = Math.max(bestTrigramEx, jaccardSimilarity(inputTrigrams, charTrigrams(ex)));
  }
  const trigramScore = Math.max(bestTrigramEx, jaccardSimilarity(inputTrigrams, descTrigrams) * 0.8);

  // Best signal wins (slight discount on fuzzier methods)
  return Math.max(stemmedScore, prefixScore * 0.95, trigramScore * 0.85);
}

/**
 * Classify user input against modules using multi-signal similarity:
 * 1. Snowball-stemmed Jaccard (language-aware inflection handling)
 * 2. Prefix overlap (morphological variants)
 * 3. Character trigrams (typos, fuzzy matches)
 *
 * Maps raw scores to confidence buckets:
 * - >= 0.5 → 0.93 (high confidence)
 * - >= 0.4 → 0.86 (medium-high)
 * - >= 0.15 → 0.72 (medium)
 * - < 0.15 → ambiguous
 */
export function classifyWithHeuristics(
  message: string,
  modules: ModuleDefinition[],
  locale?: string,
): IntentClassification {
  const stemmer = stemmerForLocale(locale);
  const raw = rawTokenize(message);
  const inputTokens = toSet(raw);
  const inputStems = stemTokens(raw, stemmer);
  const inputTrigrams = charTrigrams(message);

  if (inputTokens.size === 0 || modules.length === 0) {
    return { intent: 'ambiguous', confidence: 0 };
  }

  const scored = modules.map((m) => ({
    moduleId: m.id,
    score: scoreModule(inputTokens, inputStems, inputTrigrams, m, stemmer),
  }));

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < 0.15) {
    return { intent: 'ambiguous', confidence: 0 };
  }

  // Map raw Jaccard score to confidence buckets
  const confidence =
    best.score >= 0.5 ? 0.93 : best.score >= 0.4 ? 0.86 : 0.72;

  return { intent: best.moduleId, confidence };
}

// ============================================================================
// LLM Classification
// ============================================================================

/**
 * Build the classification prompt for LLM-based intent classification.
 */
export function buildClassificationPrompt(
  message: string,
  modules: ModuleDefinition[],
  history?: ConversationMessage[],
): string {
  const moduleDescriptions = modules
    .map((m) => {
      const examples = m.classification?.examples ?? [];
      const examplesStr =
        examples.length > 0
          ? ` Examples: ${examples.map((e) => `"${e}"`).join(', ')}`
          : '';
      return `- ${m.id}: ${m.description}.${examplesStr}`;
    })
    .join('\n');

  const historyContext =
    history && history.length > 0
      ? `\nConversation history:\n${history.map((h) => `${h.role}: ${h.content}`).join('\n')}\n`
      : '';

  return `You are an intent classifier. Given a user message, determine which module best handles it.

Available modules:
${moduleDescriptions}

Respond with JSON only: { "moduleId": "<module_id>", "confidence": <0.0-1.0> }
If no module matches well, use confidence < 0.3.
${historyContext}
User message: "${message}"`;
}

/**
 * Parse a JSON response from the LLM, tolerating markdown code blocks
 * and other wrapper text.
 */
export function parseJsonResponse(
  text: string,
): { moduleId: string; confidence: number } | null {
  const validate = (obj: unknown): { moduleId: string; confidence: number } | null => {
    if (
      typeof obj === 'object' && obj !== null &&
      typeof (obj as Record<string, unknown>).moduleId === 'string' &&
      typeof (obj as Record<string, unknown>).confidence === 'number'
    ) {
      return obj as { moduleId: string; confidence: number };
    }
    return null;
  };

  // Strip markdown fences before attempting parse
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

  try {
    return validate(JSON.parse(cleaned));
  } catch {
    // Try extracting any JSON object containing both required fields
    const jsonMatch = cleaned.match(/\{[^}]*"(?:moduleId|confidence)"[^}]*\}/);
    if (jsonMatch) {
      try {
        return validate(JSON.parse(jsonMatch[0]));
      } catch {
        // Give up
      }
    }
  }
  return null;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a local intent classifier that uses the user's own model for
 * LLM classification, falling back to a multi-signal heuristic when
 * the LLM is unavailable or fails.
 *
 * Heuristics use Snowball stemming (24 languages), prefix overlap, and
 * character trigrams for language-agnostic fuzzy matching.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 *
 * const classifier = createIntentClassifier({
 *   modules: [taskModule, calendarModule],
 *   model: openai('gpt-4o-mini'),
 *   generateText,
 *   locale: 'de',
 * });
 *
 * const result = await classifier.classify('create a new task');
 * // { intent: 'tasks', confidence: 0.95 }
 * ```
 */
export function createIntentClassifier(
  config: LocalClassifierConfig,
): IntentClassifier {
  const {
    modules,
    model,
    generateText,
    timeoutMs = 2000,
    confidenceThreshold = 0.5,
    minTokens = 2,
    locale,
  } = config;

  return {
    async classify(
      input: string,
      _context?: ToolContext,
      conversationHistory?: ConversationMessage[],
    ): Promise<IntentClassification> {
      // Short-circuit: not enough tokens to classify meaningfully
      const tokens = tokenize(input);
      if (tokens.size < minTokens || modules.length === 0) {
        return { intent: 'ambiguous', confidence: 0 };
      }

      // Try LLM classification when both model and generateText are available
      if (model && generateText) {
        try {
          const result = await classifyWithLlm(
            input,
            modules,
            model,
            generateText,
            timeoutMs,
            conversationHistory,
          );
          if (result.confidence >= confidenceThreshold) {
            return result;
          }
          // LLM returned low confidence — fall through to heuristics
        } catch {
          // LLM failed — fall through to heuristics
        }
      }

      return classifyWithHeuristics(input, modules, locale);
    },
  };
}

// ============================================================================
// Internal LLM Classification
// ============================================================================

async function classifyWithLlm(
  input: string,
  modules: ModuleDefinition[],
  model: unknown,
  generateText: LocalClassifierConfig['generateText'] & {},
  timeoutMs: number,
  conversationHistory?: ConversationMessage[],
): Promise<IntentClassification> {
  const prompt = buildClassificationPrompt(input, modules, conversationHistory);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let result: { text: string };
  try {
    result = await generateText({ model, prompt, abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseJsonResponse(result.text);
  if (!parsed) {
    throw new Error('Failed to parse LLM JSON response');
  }

  // Validate moduleId exists in configured modules
  const matchedModule = modules.find((m) => m.id === parsed.moduleId);
  if (!matchedModule) {
    return {
      intent: 'ambiguous',
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
    };
  }

  return {
    intent: parsed.moduleId,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
  };
}
