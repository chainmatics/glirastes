import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getCliVersion } from '../utils/get-cli-version.js';
import { getChangelogDiff, type ChangelogEntry } from '../utils/changelog-parser.js';
import { detectGaps, type Gap } from '../utils/gap-detector.js';

interface ManagedManifest {
  version: string;
  previousVersion?: string;
  skills: Record<string, string[]>;
}

export interface CheckUpgradeOptions {
  rootDir: string;
  fromVersion?: string;
  cliVersion?: string;
  log?: (message: string) => void;
}

export interface UpgradeAnalysis {
  fromVersion: string;
  toVersion: string;
  entries: ChangelogEntry[];
  gaps: Gap[];
}

const SCANNABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.claude',
]);

export async function checkUpgrade(options: CheckUpgradeOptions): Promise<UpgradeAnalysis> {
  const log = options.log ?? console.log;
  const toVersion = options.cliVersion ?? getCliVersion();
  const fromVersion = resolveFromVersion(options.rootDir, options.fromVersion);
  const changelogPath = resolveChangelogPath(options.rootDir);
  const changelogContent = readFileSync(changelogPath, 'utf-8');
  const entries = getChangelogDiff(changelogContent, fromVersion, toVersion);

  if (entries.length === 0) {
    log(`Upgrade Analysis: v${fromVersion} -> v${toVersion}`);
    log('No changelog entries found between these versions.');
    if (fromVersion === toVersion) {
      log('Tip: run with --from-version <previous-version> to analyze an older baseline.');
    }
    return { fromVersion, toVersion, entries, gaps: [] };
  }

  const codebase = readProjectCodebase(options.rootDir);
  const gaps = detectGaps(entries, codebase);

  printReport(log, fromVersion, toVersion, gaps);
  return { fromVersion, toVersion, entries, gaps };
}

function resolveFromVersion(rootDir: string, explicitFromVersion?: string): string {
  if (explicitFromVersion) return explicitFromVersion;

  const manifestPath = join(rootDir, '.claude', 'skills', '.managed.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'No .claude/skills/.managed.json found. Pass --from-version <version> to analyze upgrade gaps.',
    );
  }

  let manifest: ManagedManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    throw new Error('Could not parse .claude/skills/.managed.json');
  }

  const previousVersion = manifest.previousVersion?.trim();
  if (previousVersion) return previousVersion;

  const version = manifest.version?.trim();
  if (version) return version;

  throw new Error('Managed manifest is missing a valid version field.');
}

function resolveChangelogPath(rootDir: string): string {
  const candidates = [
    join(rootDir, 'node_modules', 'glirastes', 'CHANGELOG.md'),
    join(rootDir, 'packages', 'cli', 'CHANGELOG.md'),
    join(rootDir, 'CHANGELOG.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    'Cannot find CHANGELOG.md in glirastes. Update the package first.',
  );
}

function readProjectCodebase(rootDir: string): string {
  const chunks: string[] = [];
  walkFiles(rootDir, (filePath) => {
    const extension = extname(filePath).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(extension)) return;

    try {
      chunks.push(readFileSync(filePath, 'utf-8'));
    } catch {
      // Best-effort scanning: unreadable files are skipped.
    }
  });
  return chunks.join('\n');
}

function walkFiles(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walkFiles(fullPath, onFile);
      continue;
    }
    if (entry.isFile()) onFile(fullPath);
  }
}

function printReport(
  log: (message: string) => void,
  fromVersion: string,
  toVersion: string,
  gaps: Gap[],
): void {
  const missingFeatures = gaps.filter((gap) => gap.type === 'missing-feature');
  const breakingChanges = gaps.filter((gap) => gap.type === 'breaking-change');

  log(`Upgrade Analysis: v${fromVersion} -> v${toVersion}`);

  log('');
  log(`New Features (${missingFeatures.length} opportunities):`);
  if (missingFeatures.length === 0) {
    log('  None detected.');
  } else {
    missingFeatures.forEach((gap, index) => {
      log(`  [${index + 1}] ${gap.changelogItem.description}`);
      log(`      Package: ${gap.changelogItem.package}`);
      if (gap.suggestion) log(`      Suggestion: ${gap.suggestion}`);
    });
  }

  log('');
  log(`Breaking Changes (${breakingChanges.length} affecting you):`);
  if (breakingChanges.length === 0) {
    log('  None detected.');
  } else {
    breakingChanges.forEach((gap, index) => {
      log(`  [${index + 1}] ${gap.changelogItem.description}`);
      log(`      Package: ${gap.changelogItem.package}`);
      if (gap.suggestion) log(`      Action: ${gap.suggestion}`);
    });
  }
}
