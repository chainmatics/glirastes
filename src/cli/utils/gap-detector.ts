// packages/cli/src/utils/gap-detector.ts
import type { ChangelogEntry, ChangelogItem } from './changelog-parser.js';

export type GapType = 'missing-feature' | 'breaking-change';

export interface Gap {
  type: GapType;
  feature?: string;
  changelogItem: ChangelogItem;
  affectsUser: boolean;
  suggestion?: string;
}

/**
 * Escapes special regex characters to prevent ReDoS attacks
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect gaps between changelog and consumer codebase.
 * This is a simple heuristic-based approach (regex scanning).
 */
export function detectGaps(
  entries: ChangelogEntry[],
  codebase: string,
): Gap[] {
  const gaps: Gap[] = [];

  for (const entry of entries) {
    // Check Added features
    for (const item of entry.added) {
      const featureName = extractFeatureName(item.description);
      if (!featureName) continue;

      // Check if feature keyword appears in codebase
      const escapedFeature = escapeRegex(featureName);
      const regex = new RegExp(`\\b${escapedFeature}\\b`, 'i');
      const isUsed = regex.test(codebase);

      if (!isUsed) {
        gaps.push({
          type: 'missing-feature',
          feature: featureName,
          changelogItem: item,
          affectsUser: false, // They could use it but aren't
          suggestion: `Consider using ${featureName} in your ${item.package} config`,
        });
      }
    }

    // Check Breaking changes
    for (const item of entry.breaking) {
      const oldPattern = extractOldPattern(item.description);
      if (!oldPattern) continue;

      const escapedPattern = escapeRegex(oldPattern);
      const regex = new RegExp(escapedPattern);
      const affectsUser = regex.test(codebase);

      if (affectsUser) {
        gaps.push({
          type: 'breaking-change',
          changelogItem: item,
          affectsUser: true,
          suggestion: `BREAKING: Update ${oldPattern} usage in your code`,
        });
      }
    }
  }

  return gaps;
}

function extractFeatureName(description: string): string | null {
  // Extract feature name from common patterns
  // "relatedModules generated..." -> "relatedModules"
  const match = description.match(/^(\w+)/);
  return match ? match[1] : null;
}

function extractOldPattern(description: string): string | null {
  // Extract old pattern from breaking change descriptions
  // "ModelTier.FAST renamed to ModelTier.Fast" -> "ModelTier.FAST"
  const match = description.match(/(\w+\.\w+)\s+renamed/);
  return match ? match[1] : null;
}
