import { z } from 'zod';
import { findSensitiveStringPath } from './content-boundary.js';

const uuid = z.uuid();
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);

/**
 * Generous enough for a real prompt, small enough that a source tree or a
 * transcript cannot be smuggled through one section.
 */
const section = z.string().trim().min(1).max(100_000);

/**
 * A prompt revision authored on the Platform.
 *
 * This is the one declared place where prompt content is allowed to leave the
 * customer environment, opted into per app. The local bundle remains the
 * default and the fail-closed floor; this overrides it only once published,
 * signed, and pinned by a rollout.
 *
 * The narrowing is deliberate and stays local to this type: every other
 * control-plane payload keeps rejecting prompt text through
 * `findForbiddenPlatformContentPath`. Credentials and other secret-shaped
 * values are rejected here too, because opting into prompt text is not
 * opting into secrets.
 */
export const PlatformPromptRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: uuid,
  appId: uuid,
  bundleDigest: digest,
  sections: z.object({
    planner: section,
    appBehavior: section,
    responseStyle: section,
  }).strict(),
}).strict().superRefine((revision, context) => {
  const sensitive = findSensitiveStringPath(revision.sections);
  if (sensitive) {
    context.addIssue({
      code: 'custom',
      message: 'Prompt sections must not contain secret-shaped values',
      path: ['sections', ...sensitive],
    });
  }
});

export type PlatformPromptRevision = z.infer<typeof PlatformPromptRevisionSchema>;
