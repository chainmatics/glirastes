import { describe, it, expect } from 'vitest';
import { createSessionStore } from '../session-mapping.js';

describe('SessionStore', () => {
  it('creates a new session on first access', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    expect(session).toBeDefined();
  });

  it('returns same session for same sessionId', () => {
    const store = createSessionStore('de');
    const s1 = store.getOrCreate('session-1');
    const s2 = store.getOrCreate('session-1');
    expect(s1).toBe(s2);
  });

  it('returns different sessions for different sessionIds', () => {
    const store = createSessionStore('de');
    const s1 = store.getOrCreate('session-1');
    const s2 = store.getOrCreate('session-2');
    expect(s1).not.toBe(s2);
  });

  it('maps original to deterministic pseudonym', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    const p1 = session.getOrCreatePseudonym('Max Müller', 'person');
    const p2 = session.getOrCreatePseudonym('Max Müller', 'person');
    expect(p1).toBe(p2);
    expect(p1).not.toBe('Max Müller');
  });

  it('generates different pseudonyms for different originals', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    const p1 = session.getOrCreatePseudonym('Max Müller', 'person');
    const p2 = session.getOrCreatePseudonym('Anna Schmidt', 'person');
    expect(p1).not.toBe(p2);
  });

  it('resolves pseudonym back to original', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    const pseudonym = session.getOrCreatePseudonym('max@test.com', 'email');
    const original = session.resolveOriginal(pseudonym);
    expect(original).toBe('max@test.com');
  });

  it('returns undefined for unknown pseudonym', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    expect(session.resolveOriginal('unknown')).toBeUndefined();
  });

  it('clears a session', () => {
    const store = createSessionStore('de');
    store.getOrCreate('session-1').getOrCreatePseudonym('test', 'person');
    store.clear('session-1');
    const session = store.getOrCreate('session-1');
    expect(session.resolveOriginal('anything')).toBeUndefined();
  });

  it('lists all known originals', () => {
    const store = createSessionStore('de');
    const session = store.getOrCreate('session-1');
    session.getOrCreatePseudonym('Max Müller', 'person');
    session.getOrCreatePseudonym('max@test.com', 'email');
    expect(session.allOriginals()).toEqual(['Max Müller', 'max@test.com']);
  });

  describe('getPseudonym', () => {
    it('returns pseudonym for a known original', () => {
      const store = createSessionStore('de');
      const session = store.getOrCreate('session-1');
      const pseudonym = session.getOrCreatePseudonym('Max Müller', 'person');
      expect(session.getPseudonym('Max Müller')).toBe(pseudonym);
    });

    it('returns undefined for an unknown original', () => {
      const store = createSessionStore('de');
      const session = store.getOrCreate('session-1');
      expect(session.getPseudonym('Unknown Person')).toBeUndefined();
    });
  });

  describe('pseudonym collision detection', () => {
    it('maps two different originals of the same category to different pseudonyms', () => {
      const store = createSessionStore('de');
      const session = store.getOrCreate('session-1');
      const p1 = session.getOrCreatePseudonym('Max Müller', 'person');
      const p2 = session.getOrCreatePseudonym('Anna Schmidt', 'person');
      expect(p1).not.toBe(p2);
      expect(session.resolveOriginal(p1)).toBe('Max Müller');
      expect(session.resolveOriginal(p2)).toBe('Anna Schmidt');
    });

    it('maps many originals of the same category without collision', () => {
      const store = createSessionStore('de');
      const session = store.getOrCreate('collision-test');
      const names = [
        'Person A', 'Person B', 'Person C', 'Person D', 'Person E',
        'Person F', 'Person G', 'Person H', 'Person I', 'Person J',
      ];
      const pseudonyms = new Set<string>();
      for (const name of names) {
        const p = session.getOrCreatePseudonym(name, 'person');
        pseudonyms.add(p);
      }
      // All pseudonyms should be unique
      expect(pseudonyms.size).toBe(names.length);
      // All should resolve back correctly
      for (const name of names) {
        const p = session.getPseudonym(name);
        expect(p).toBeDefined();
        expect(session.resolveOriginal(p!)).toBe(name);
      }
    });
  });
});
