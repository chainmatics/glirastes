// packages/cli/src/utils/changelog-parser.ts
export interface ChangelogItem {
  description: string;
  package: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  added: ChangelogItem[];
  fixed: ChangelogItem[];
  breaking: ChangelogItem[];
}

export function parseChangelog(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = content.split('\n');

  let currentEntry: ChangelogEntry | null = null;
  let currentSection: 'added' | 'fixed' | 'breaking' | null = null;

  for (const line of lines) {
    // Match version header: ## [0.7.2] - 2025-03-05
    const versionMatch = line.match(/^##\s+\[(\d+\.\d+\.\d+)\]\s+-\s+(\d{4}-\d{2}-\d{2})/);
    if (versionMatch) {
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        version: versionMatch[1].trim(),
        date: versionMatch[2].trim(),
        added: [],
        fixed: [],
        breaking: [],
      };
      currentSection = null;
      continue;
    }

    // Match section headers
    if (line.match(/^###\s+Added/i)) {
      currentSection = 'added';
      continue;
    }
    if (line.match(/^###\s+Fixed/i)) {
      currentSection = 'fixed';
      continue;
    }
    if (line.match(/^###\s+Changed\s+\(Breaking\)/i)) {
      currentSection = 'breaking';
      continue;
    }

    // Match items: - Description (package-name)
    // First try to match with package annotation
    const itemMatch = line.match(/^-\s+([^(]+)\(([^)]+)\)$/);
    if (itemMatch && currentEntry && currentSection) {
      const item: ChangelogItem = {
        description: itemMatch[1].trim(),
        package: itemMatch[2].trim(),
      };
      currentEntry[currentSection].push(item);
    } else {
      // Fallback: match items without package annotation
      const simpleItemMatch = line.match(/^-\s+(.+)$/);
      if (simpleItemMatch && currentEntry && currentSection) {
        const item: ChangelogItem = {
          description: simpleItemMatch[1].trim(),
          package: 'core', // default package for items without annotation
        };
        currentEntry[currentSection].push(item);
      }
    }
  }

  if (currentEntry) entries.push(currentEntry);
  return entries;
}

export function getChangelogDiff(
  content: string,
  fromVersion: string,
  toVersion: string,
): ChangelogEntry[] {
  const allEntries = parseChangelog(content);

  const hasFromVersion = allEntries.some((e) => e.version === fromVersion);
  const hasToVersion = allEntries.some((e) => e.version === toVersion);
  if (!hasFromVersion || !hasToVersion) return [];

  if (compareSemver(fromVersion, toVersion) >= 0) return [];

  // Include versions newer than fromVersion and up to toVersion (inclusive).
  return allEntries.filter((entry) => {
    return compareSemver(entry.version, fromVersion) > 0 &&
      compareSemver(entry.version, toVersion) <= 0;
  });
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10));
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const aValue = Number.isNaN(aParts[i]) ? 0 : (aParts[i] ?? 0);
    const bValue = Number.isNaN(bParts[i]) ? 0 : (bParts[i] ?? 0);
    if (aValue > bValue) return 1;
    if (aValue < bValue) return -1;
  }

  return 0;
}
