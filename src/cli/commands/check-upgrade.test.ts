import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkUpgrade, type UpgradeAnalysis } from './check-upgrade.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'glirastes-check-upgrade-'));
  tempDirs.push(dir);
  return dir;
}

function writeManagedManifest(rootDir: string, version: string, previousVersion?: string): void {
  const manifestPath = join(rootDir, '.claude', 'skills', '.managed.json');
  mkdirSync(join(rootDir, '.claude', 'skills'), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version,
        ...(previousVersion ? { previousVersion } : {}),
        skills: {},
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

function writeChangelog(rootDir: string, content: string): string {
  const changelogPath = join(rootDir, 'node_modules', 'glirastes', 'CHANGELOG.md');
  mkdirSync(join(rootDir, 'node_modules', 'glirastes'), { recursive: true });
  writeFileSync(changelogPath, content, 'utf-8');
  return changelogPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkUpgrade', () => {
  it('requires --from-version when no managed manifest exists', async () => {
    const rootDir = makeTempProject();
    writeChangelog(
      rootDir,
      `# Changelog

## [0.9.1] - 2026-03-05
### Added
- relatedModules generated from tool overlap (codegen)
`,
    );

    await expect(
      checkUpgrade({
        rootDir,
        cliVersion: '0.9.1',
      }),
    ).rejects.toThrow('No .claude/skills/.managed.json found');
  });

  it('uses previousVersion from managed manifest and finds gaps', async () => {
    const rootDir = makeTempProject();
    writeManagedManifest(rootDir, '0.9.1', '0.9.0');
    writeChangelog(
      rootDir,
      `# Changelog

## [0.9.1] - 2026-03-05
### Added
- relatedModules generated from tool overlap (codegen)
### Changed (Breaking)
- ModelTier.FAST renamed to ModelTier.Fast (ai-router)

## [0.9.0] - 2026-03-01
### Added
- Baseline release (core)
`,
    );

    mkdirSync(join(rootDir, 'src'), { recursive: true });
    writeFileSync(
      join(rootDir, 'src', 'module.ts'),
      `const tier = ModelTier.FAST;\nexport const moduleDef = { id: 'x' };`,
      'utf-8',
    );

    const analysis = await checkUpgrade({
      rootDir,
      cliVersion: '0.9.1',
    });

    expect(analysis.fromVersion).toBe('0.9.0');
    expect(analysis.toVersion).toBe('0.9.1');
    expect(analysis.entries).toHaveLength(1);
    expect(analysis.gaps.some((g: UpgradeAnalysis['gaps'][number]) => g.type === 'missing-feature')).toBe(true);
    expect(analysis.gaps.some((g: UpgradeAnalysis['gaps'][number]) => g.type === 'breaking-change')).toBe(true);
  });

  it('returns empty diff when fromVersion equals toVersion', async () => {
    const rootDir = makeTempProject();
    writeManagedManifest(rootDir, '0.9.1');
    writeChangelog(
      rootDir,
      `# Changelog

## [0.9.1] - 2026-03-05
### Added
- relatedModules generated from tool overlap (codegen)
`,
    );

    const analysis = await checkUpgrade({
      rootDir,
      cliVersion: '0.9.1',
    });

    expect(analysis.entries).toEqual([]);
    expect(analysis.gaps).toEqual([]);
  });
});
