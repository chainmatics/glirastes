import { describe, expect, it } from 'vitest';
import {
  canonicalPromptBundleJson,
  PromptBundleSchema,
  PromptRevisionMetadataSchema,
} from '../prompt-bundle.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const bundle = {
  schemaVersion: 1,
  bundleId: id('501'),
  appId: id('502'),
  revisionId: id('503'),
  revision: 1,
  bundleDigest: digest('A'),
  sections: {
    planner: 'Plan only the minimum steps needed.',
    appBehavior: 'Use local task tools and preserve authorization.',
    responseStyle: 'Answer directly and concisely.',
    capabilityFragments: [{
      id: 'task-management',
      content: 'Prefer explicit task identifiers.',
    }],
  },
  createdAt: '2026-07-30T10:00:00.000Z',
  signature: {
    algorithm: 'Ed25519',
    keyId: 'runtime-signing-2026-01',
    value: 'c2lnbmF0dXJl',
  },
} as const;

const metadata = {
  schemaVersion: 1,
  revisionId: id('503'),
  appId: id('502'),
  revision: 1,
  bundleDigest: digest('A'),
  artifactRef: 'registry://get-it-done/prompts/v1',
  plannerDigest: digest('B'),
  groupDigests: {
    appBehavior: digest('C'),
    responseStyle: digest('D'),
  },
  createdAt: '2026-07-30T10:00:00.000Z',
} as const;

describe('PromptBundleSchema', () => {
  it('keeps the approved prompt groups independent in a local artifact', () => {
    const parsed = PromptBundleSchema.parse(bundle);

    expect(parsed.sections.planner).toContain('minimum steps');
    expect(parsed.sections.appBehavior).toContain('authorization');
    expect(parsed.sections.responseStyle).toContain('directly');
  });

  it('supports parent-linked immutable revisions', () => {
    expect(PromptBundleSchema.safeParse({
      ...bundle,
      revision: 2,
      parentRevisionId: id('504'),
    }).success).toBe(true);
  });

  it('canonicalizes equivalent bundle values identically', () => {
    const reordered = {
      signature: bundle.signature,
      createdAt: bundle.createdAt,
      sections: {
        responseStyle: bundle.sections.responseStyle,
        capabilityFragments: bundle.sections.capabilityFragments,
        appBehavior: bundle.sections.appBehavior,
        planner: bundle.sections.planner,
      },
      bundleDigest: bundle.bundleDigest,
      revision: bundle.revision,
      revisionId: bundle.revisionId,
      appId: bundle.appId,
      bundleId: bundle.bundleId,
      schemaVersion: bundle.schemaVersion,
    };

    expect(canonicalPromptBundleJson(reordered))
      .toBe(canonicalPromptBundleJson(bundle));
  });
});

describe('PromptRevisionMetadataSchema', () => {
  it('accepts content-free Platform metadata', () => {
    expect(PromptRevisionMetadataSchema.parse(metadata).artifactRef)
      .toBe(metadata.artifactRef);
  });

  it.each([
    { planner: 'raw planner prompt' },
    { prompt: 'raw combined prompt' },
    { sections: bundle.sections },
    { rawModelOutput: 'assessment transcript' },
    { credentials: { token: 'provider-token' } },
  ])('rejects prompt content, transcripts, or credentials', (forbidden) => {
    expect(PromptRevisionMetadataSchema.safeParse({
      ...metadata,
      ...forbidden,
    }).success).toBe(false);
  });
});
