import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pieces an operator can choose to install.
 *
 * Parts exist so the installer can propose a selection derived from the project
 * rather than presenting an unexplained menu, and so declining one leaves no
 * files from it.
 */
export const INSTALLER_PARTS = [
  'framework',
  'chat-ui',
  'tools',
  'setup',
] as const;

export type InstallerPart = (typeof INSTALLER_PARTS)[number];

/** Stacks the installer can recognise on its own. */
export type DetectedStack = 'nextjs';

export interface PartResolutionContext {
  /** What `detectStack` found, or `null` when nothing was recognised. */
  stack: DetectedStack | null;
}

/**
 * Skills each part contributes. The framework part is stack-dependent, so it
 * resolves through the detected stack rather than a fixed name.
 */
const FRAMEWORK_SKILLS: Record<DetectedStack, ReadonlyArray<string>> = {
  nextjs: ['integrating-glirastes-nextjs'],
};

const PART_SKILLS: Record<
  Exclude<InstallerPart, 'framework'>,
  ReadonlyArray<string>
> = {
  'chat-ui': ['building-glirastes-chat-ui'],
  tools: ['maintaining-glirastes-tools'],
  setup: ['setting-up-glirastes'],
};

/** Dependency whose presence proves a stack, rather than a heuristic. */
const STACK_MARKERS: ReadonlyArray<[DetectedStack, string]> = [
  ['nextjs', 'next'],
];

/**
 * Recognise the project's stack from its manifest. Absence of a manifest, or of
 * any known marker, is not an error — it only means the framework part cannot be
 * proposed.
 */
export async function detectStack(
  rootDir: string,
): Promise<DetectedStack | null> {
  let manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(
      await readFile(join(rootDir, 'package.json'), 'utf8'),
    ) as typeof manifest;
  } catch {
    return null;
  }

  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const [stack, marker] of STACK_MARKERS) {
    if (marker in declared) return stack;
  }
  return null;
}

/**
 * The selection the installer offers before the operator edits it.
 *
 * `setup` is deliberately absent: it carries a host choice and, in autonomous
 * mode, the only egress this tool has. It stays an explicit decision.
 */
export function proposeParts(stack: DetectedStack | null): InstallerPart[] {
  const proposed: InstallerPart[] = ['tools', 'chat-ui'];
  if (stack) proposed.unshift('framework');
  return proposed;
}

export function resolvePartSkills(
  parts: ReadonlyArray<InstallerPart>,
  context: PartResolutionContext,
): string[] {
  const resolved: string[] = [];
  for (const part of parts) {
    if (!INSTALLER_PARTS.includes(part)) {
      throw new Error(
        `Unknown installer part: '${part}'. Use one of: ${INSTALLER_PARTS.join(' | ')}.`,
      );
    }
    const skills = part === 'framework'
      ? (context.stack ? FRAMEWORK_SKILLS[context.stack] : [])
      : PART_SKILLS[part];
    for (const skill of skills) {
      if (!resolved.includes(skill)) resolved.push(skill);
    }
  }
  return resolved;
}

/** Human-readable label for a part, for the confirmation prompt. */
export const PART_LABELS: Record<InstallerPart, string> = {
  framework: 'framework integration',
  'chat-ui': 'chat UI',
  tools: 'tool maintenance',
  setup: 'setup and assessment',
};
