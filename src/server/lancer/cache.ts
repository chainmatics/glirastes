// ---------------------------------------------------------------------------
// Simple in-memory Map cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private readonly ttl: number) {}

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttl });
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
