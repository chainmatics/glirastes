import type { PiiCategory } from '../../types.js';
import { createFakeDataGenerator, type FakeDataGenerator } from './fake-data.js';

export interface Session {
  getOrCreatePseudonym(original: string, category: PiiCategory | string): string;
  getPseudonym(original: string): string | undefined;
  resolveOriginal(pseudonym: string): string | undefined;
  allOriginals(): string[];
}

export interface SessionStore {
  getOrCreate(sessionId: string): Session;
  clear(sessionId: string): void;
}

function seedFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash || 1;
}

function createSession(sessionId: string, locale: string): Session {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const gen: FakeDataGenerator = createFakeDataGenerator(seedFromString(sessionId), locale);

  return {
    getOrCreatePseudonym(original: string, category: PiiCategory | string): string {
      const existing = forward.get(original);
      if (existing) return existing;

      let pseudonym = gen.generate(category);

      // Collision detection: if this pseudonym already maps to a different original, regenerate
      const MAX_RETRIES = 10;
      let retries = 0;
      while (reverse.has(pseudonym) && reverse.get(pseudonym) !== original) {
        retries++;
        if (retries > MAX_RETRIES) {
          // Append numeric suffix to guarantee uniqueness
          let suffix = 1;
          let candidate = `${pseudonym}-${suffix}`;
          while (reverse.has(candidate) && reverse.get(candidate) !== original) {
            suffix++;
            candidate = `${pseudonym}-${suffix}`;
          }
          pseudonym = candidate;
          break;
        }
        pseudonym = gen.generate(category);
      }

      forward.set(original, pseudonym);
      reverse.set(pseudonym, original);
      return pseudonym;
    },
    getPseudonym(original: string): string | undefined {
      return forward.get(original);
    },
    resolveOriginal(pseudonym: string): string | undefined {
      return reverse.get(pseudonym);
    },
    allOriginals(): string[] {
      return [...forward.keys()];
    },
  };
}

export function createSessionStore(locale: string): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    getOrCreate(sessionId: string): Session {
      let session = sessions.get(sessionId);
      if (!session) {
        session = createSession(sessionId, locale);
        sessions.set(sessionId, session);
      }
      return session;
    },
    clear(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
}
