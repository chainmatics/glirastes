import { describe, expect, it } from 'vitest';
import { PlatformPromptRevisionSchema } from '../index.js';
import { findForbiddenPlatformContentPath } from '../content-boundary.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const revision = {
  schemaVersion: 1 as const,
  revisionId: id('501'),
  appId: id('502'),
  bundleDigest: digest('A'),
  sections: {
    planner: 'Decompose the request, then stop when the goal is met.',
    appBehavior: 'Help verified users manage their tasks.',
    responseStyle: 'Answer in German, briefly.',
  },
};

describe('platform-authored prompt revision', () => {
  /**
   * The operator explicitly opted into authoring prompt text on the Platform.
   * It is the one declared place where prompt content is allowed, so the
   * schema has to accept it while everything else stays rejected.
   */
  it('accepts the three standard prompt groups', () => {
    const parsed = PlatformPromptRevisionSchema.parse(revision);

    expect(parsed.sections.planner).toContain('Decompose');
  });

  it('bounds each section so it cannot become a source dump', () => {
    expect(() => PlatformPromptRevisionSchema.parse({
      ...revision,
      sections: { ...revision.sections, planner: 'x'.repeat(100_001) },
    })).toThrow();
  });

  it('still rejects a credential hidden inside a section', () => {
    expect(() => PlatformPromptRevisionSchema.parse({
      ...revision,
      sections: {
        ...revision.sections,
        planner: 'Use sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 to call out.',
      },
    })).toThrow();
  });

  it('rejects any field beyond the declared groups', () => {
    expect(() => PlatformPromptRevisionSchema.parse({
      ...revision,
      sections: { ...revision.sections, sourceCode: 'export function GET() {}' },
    })).toThrow();
  });

  /**
   * The narrowing is per revision type, not global: a setup artifact or a
   * runtime revision must still never carry prompt text.
   */
  it('does not widen the boundary for other control-plane payloads', () => {
    expect(findForbiddenPlatformContentPath({
      tools: [{ prompt: 'you are a helpful assistant' }],
    })).not.toBeNull();
  });
});
