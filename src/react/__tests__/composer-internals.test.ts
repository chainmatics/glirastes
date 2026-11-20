import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { computeApiSurface } from '../../../scripts/api-surface.js';
import * as react from '../index.js';
import type { ChatContextValue, CompletionSearch, RichMentionInputHandle, RichMentionInputProps } from '../index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Helpers of the composer that stay internal: removing them later would break apps. */
describe('composer internals stay out of the public API', () => {
  let surface: Set<string>;
  beforeAll(async () => {
    surface = new Set(await computeApiSurface(repoRoot));
  }, 120_000);

  it('does not export the trigger resolution helpers', () => {
    for (const name of ['resolveChatTriggers', 'normalizeTrigger', 'createMentionPrefixLookup']) {
      expect(name in react, name).toBe(false);
    }
  });

  it('has no surface key for the internal types and members', () => {
    for (const key of [
      'glirastes/react#resolveChatTriggers',
      'glirastes/react#ResolvedChatTrigger',
      'glirastes/react#CompletionSearchQueryOptions',
      'glirastes/react#RichMentionInputHandle.pickCompletion',
      'glirastes/react#ChatContextValue.triggers',
      'glirastes/react#ChatContextValue.composer',
      'glirastes/react#ChatContextValue.onCompletionSelect',
      'glirastes/react#ChatContextValue.mentionPrefix',
    ]) {
      expect(surface.has(key), key).toBe(false);
    }
  });

  it('keeps the public search and handle signatures of the released SDK', () => {
    expectTypeOf<RichMentionInputHandle>().not.toHaveProperty('pickCompletion');
    expectTypeOf<ChatContextValue>().not.toHaveProperty('triggers');
    expectTypeOf<Parameters<CompletionSearch>>().toEqualTypeOf<[query: string, trigger: string]>();
    expectTypeOf<Parameters<NonNullable<RichMentionInputProps['onSearch']>>>()
      .toEqualTypeOf<[query: string, trigger: string]>();
  });
});
