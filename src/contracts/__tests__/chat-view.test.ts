import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHAT_VIEW_LIMITS,
  chatComponentManifestDigest,
  chatComponentManifestSchema,
  chatViewSpecSchema,
  resolvedChatViewSchema,
} from '../chat-view.js';

const vectors = JSON.parse(
  readFileSync(new URL('../__vectors__/chat-view.v1.json', import.meta.url), 'utf8'),
);

describe('chat-view contract', () => {
  it('parses vector chat-view.v1.json', () => {
    expect(chatViewSpecSchema.safeParse(vectors.spec).success).toBe(true);
    expect(chatComponentManifestSchema.safeParse(vectors.manifest).success).toBe(true);
    expect(resolvedChatViewSchema.safeParse(vectors.resolved).success).toBe(true);
  });

  it('rejects element id with space', () => {
    const spec = { root: 'a b', elements: { 'a b': { type: 'Card', props: {} } } };
    expect(chatViewSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects caption over 200 chars', () => {
    const spec = { ...vectors.spec, caption: 'x'.repeat(201) };
    expect(chatViewSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('pins the limits', () => {
    expect(CHAT_VIEW_LIMITS).toEqual({
      maxElements: 60, maxDepth: 6, maxSpecBytes: 8192, maxLiteralChars: 200,
      maxTableRows: 50, maxTableColumns: 8, maxNarrowTableColumns: 3,
      maxProjectionBytes: 65536, maxSourceMemoEntries: 10,
    });
  });

  it('digests the manifest independent of key order, matching node sha-256', () => {
    const m = vectors.manifest;
    const reordered = { components: m.components, v: m.v };
    expect(chatComponentManifestDigest(reordered)).toBe(chatComponentManifestDigest(m));
    const sorted = (v: unknown): string =>
      Array.isArray(v) ? `[${v.map(sorted).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted((v as Record<string, unknown>)[k])}`).join(',')}}`
        : JSON.stringify(v);
    expect(chatComponentManifestDigest(m)).toBe(createHash('sha256').update(sorted(m)).digest('hex'));
  });
});
