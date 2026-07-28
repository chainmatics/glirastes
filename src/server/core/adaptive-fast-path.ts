import type {
  AdaptiveFastPathInstance,
  FastPathConfig,
  FastPathStats,
  FastPathStorage,
  IntentClassification,
  LearnedPattern,
} from '../../types.js';

const DEFAULT_CONFIG: Required<Omit<FastPathConfig, 'initialPatterns'>> = {
  promotionThreshold: 3,
  minConfidence: 0.85,
  maxPatterns: 500,
  patternTtlMs: 7 * 24 * 60 * 60 * 1_000,
  enableLearning: true,
  confidenceThreshold: 0.95,
};

function clonePattern(pattern: LearnedPattern): LearnedPattern {
  return { ...pattern };
}

class AdaptiveFastPath implements AdaptiveFastPathInstance {
  private readonly patterns = new Map<string, LearnedPattern>();
  private readonly config: typeof DEFAULT_CONFIG;
  private dirty = false;

  constructor(
    config: FastPathConfig = {},
    private readonly storage?: FastPathStorage,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    for (const pattern of config.initialPatterns ?? []) {
      this.patterns.set(pattern.pattern, clonePattern(pattern));
    }
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/, '');
  }

  match(input: string): IntentClassification | null {
    const key = this.normalize(input);
    const pattern = this.patterns.get(key);
    if (!pattern?.promotedAt) return null;

    if (
      this.config.patternTtlMs > 0
      && Date.now() - pattern.lastSeen > this.config.patternTtlMs
    ) {
      this.patterns.delete(key);
      this.dirty = true;
      return null;
    }

    pattern.lastSeen = Date.now();
    pattern.hitCount += 1;
    this.dirty = true;
    return {
      intent: pattern.intent,
      confidence: this.config.confidenceThreshold,
    };
  }

  learn(input: string, result: IntentClassification): void {
    if (!this.config.enableLearning) return;
    if (result.intent === 'ambiguous') return;
    if (result.confidence < this.config.minConfidence) return;
    const key = this.normalize(input);
    if (!key) return;

    const existing = this.patterns.get(key);
    if (!existing) {
      this.evictIfNeeded();
      this.patterns.set(key, {
        pattern: key,
        intent: result.intent,
        confidence: result.confidence,
        hitCount: 1,
        lastSeen: Date.now(),
        ...(this.config.promotionThreshold <= 1
          ? { promotedAt: Date.now() }
          : {}),
      });
      this.dirty = true;
      return;
    }

    if (existing.intent !== result.intent) {
      existing.intent = result.intent;
      existing.confidence = result.confidence;
      existing.hitCount = 1;
      existing.lastSeen = Date.now();
      existing.promotedAt = this.config.promotionThreshold <= 1
        ? Date.now()
        : undefined;
      this.dirty = true;
      return;
    }

    existing.hitCount += 1;
    existing.lastSeen = Date.now();
    existing.confidence = (
      existing.confidence * (existing.hitCount - 1)
      + result.confidence
    ) / existing.hitCount;
    if (
      existing.hitCount >= this.config.promotionThreshold
      && !existing.promotedAt
    ) {
      existing.promotedAt = Date.now();
    }
    this.dirty = true;
  }

  private evictIfNeeded(): void {
    if (this.patterns.size < this.config.maxPatterns) return;
    const candidates = [...this.patterns.entries()].sort(
      ([, left], [, right]) => {
        if (Boolean(left.promotedAt) !== Boolean(right.promotedAt)) {
          return left.promotedAt ? 1 : -1;
        }
        return left.lastSeen - right.lastSeen;
      },
    );
    const oldest = candidates[0]?.[0];
    if (oldest) this.patterns.delete(oldest);
  }

  getPatterns(): LearnedPattern[] {
    return [...this.patterns.values()].map(clonePattern);
  }

  getPromotedPatterns(): LearnedPattern[] {
    return this.getPatterns().filter((pattern) => pattern.promotedAt);
  }

  importPatterns(patterns: LearnedPattern[]): void {
    for (const candidate of patterns) {
      const key = this.normalize(candidate.pattern);
      if (!key) continue;
      const existing = this.patterns.get(key);
      if (!existing || candidate.hitCount > existing.hitCount) {
        this.evictIfNeeded();
        this.patterns.set(key, { ...candidate, pattern: key });
      }
    }
    this.dirty = true;
  }

  getStats(): FastPathStats {
    const patterns = this.getPatterns();
    return {
      totalPatterns: patterns.length,
      promotedPatterns: patterns.filter((pattern) => pattern.promotedAt).length,
      avgHitCount: patterns.length > 0
        ? patterns.reduce((total, pattern) => total + pattern.hitCount, 0)
          / patterns.length
        : 0,
      oldestPattern: patterns.length > 0
        ? Math.min(...patterns.map((pattern) => pattern.lastSeen))
        : Date.now(),
    };
  }

  clear(): void {
    this.patterns.clear();
    this.dirty = true;
  }

  async loadFromStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      const patterns = await this.storage.load();
      this.importPatterns(patterns);
      this.dirty = false;
    } catch {
      // Storage is an optional local optimization.
    }
  }

  async saveToStorage(): Promise<void> {
    if (!this.storage || !this.dirty) return;
    try {
      await this.storage.save(this.getPatterns());
      this.dirty = false;
    } catch {
      // Storage is an optional local optimization.
    }
  }
}

export function createAdaptiveFastPath(
  config?: FastPathConfig,
  storage?: FastPathStorage,
): AdaptiveFastPathInstance {
  return new AdaptiveFastPath(config, storage);
}

export function createInMemoryFastPathStorage(): FastPathStorage {
  let patterns: LearnedPattern[] = [];
  return {
    async load() {
      return patterns.map(clonePattern);
    },
    async save(nextPatterns) {
      patterns = nextPatterns.map(clonePattern);
    },
  };
}
