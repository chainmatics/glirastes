// packages/cli/src/utils/changelog-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseChangelog, getChangelogDiff, type ChangelogEntry } from './changelog-parser.js';

describe('parseChangelog', () => {
  it('should parse Keep a Changelog format', () => {
    const content = `# Changelog

## [0.7.2] - 2025-03-05

### Added
- relatedModules generated from tool overlap (codegen)
- New feature two (chat-react)

### Fixed
- Duplicate bubbles consolidated (chat-react)

## [0.7.1] - 2025-03-01

### Added
- Old feature (api)
`;

    const entries = parseChangelog(content);

    expect(entries).toHaveLength(2);
    expect(entries[0].version).toBe('0.7.2');
    expect(entries[0].date).toBe('2025-03-05');
    expect(entries[0].added).toHaveLength(2);
    expect(entries[0].added[0]).toEqual({
      description: 'relatedModules generated from tool overlap',
      package: 'codegen',
    });
    expect(entries[0].fixed).toHaveLength(1);
    expect(entries[0].breaking).toHaveLength(0);
  });

  it('should handle breaking changes', () => {
    const content = `# Changelog

## [1.0.0] - 2025-03-10

### Changed (Breaking)
- ModelTier enum renamed (ai-router)
- API response format changed (server-node)
`;

    const entries = parseChangelog(content);

    expect(entries[0].breaking).toHaveLength(2);
    expect(entries[0].breaking[0]).toEqual({
      description: 'ModelTier enum renamed',
      package: 'ai-router',
    });
  });

  it('should return empty array for malformed changelog', () => {
    const entries = parseChangelog('Not a valid changelog');
    expect(entries).toEqual([]);
  });

  it('should handle items without package annotations', () => {
    const content = `# Changelog

## [0.8.0] - 2025-03-06

### Added
- Feature without package
- Feature with package (chat-react)

### Fixed
- Bug fix without package
`;

    const entries = parseChangelog(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].added).toHaveLength(2);
    expect(entries[0].added[0]).toEqual({
      description: 'Feature without package',
      package: 'core',
    });
    expect(entries[0].added[1]).toEqual({
      description: 'Feature with package',
      package: 'chat-react',
    });
    expect(entries[0].fixed).toHaveLength(1);
    expect(entries[0].fixed[0]).toEqual({
      description: 'Bug fix without package',
      package: 'core',
    });
  });

  it('should trim whitespace from descriptions and package names', () => {
    const content = `# Changelog

## [0.8.0] - 2025-03-06

### Added
- Feature with extra spaces   (  chat-react  )
-   Feature with leading spaces (codegen)
`;

    const entries = parseChangelog(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].added).toHaveLength(2);
    expect(entries[0].added[0]).toEqual({
      description: 'Feature with extra spaces',
      package: 'chat-react',
    });
    expect(entries[0].added[1]).toEqual({
      description: 'Feature with leading spaces',
      package: 'codegen',
    });
  });

  it('should handle empty sections', () => {
    const content = `# Changelog

## [0.8.0] - 2025-03-06

### Added

### Fixed
- Bug fix (server-node)

### Changed (Breaking)
`;

    const entries = parseChangelog(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].added).toHaveLength(0);
    expect(entries[0].fixed).toHaveLength(1);
    expect(entries[0].breaking).toHaveLength(0);
  });

  it('should handle items with many spaces before parentheses', () => {
    const content = `# Changelog

## [0.8.0] - 2025-03-06

### Added
- Feature with many spaces               (chat-react)
`;

    const entries = parseChangelog(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].added).toHaveLength(1);
    expect(entries[0].added[0]).toEqual({
      description: 'Feature with many spaces',
      package: 'chat-react',
    });
  });
});

describe('getChangelogDiff', () => {
  it('should extract entries between two versions', () => {
    const content = `# Changelog

## [0.7.3] - 2025-03-10
### Added
- Feature C (pkg-c)

## [0.7.2] - 2025-03-05
### Added
- Feature B (pkg-b)

## [0.7.1] - 2025-03-01
### Added
- Feature A (pkg-a)
`;

    const diff = getChangelogDiff(content, '0.7.1', '0.7.3');

    // Should include all newer entries up to target version
    expect(diff).toHaveLength(2);
    expect(diff[0].version).toBe('0.7.3');
    expect(diff[1].version).toBe('0.7.2');
  });

  it('should return empty array if versions not found', () => {
    const content = `# Changelog\n## [0.7.2] - 2025-03-05\n### Added\n- Feature`;
    const diff = getChangelogDiff(content, '0.7.0', '0.7.1');
    expect(diff).toEqual([]);
  });

  it('should include fromVersion, exclude toVersion', () => {
    const content = `# Changelog
## [0.7.2] - 2025-03-05
### Added
- Feature B

## [0.7.1] - 2025-03-01
### Added
- Feature A
`;
    const diff = getChangelogDiff(content, '0.7.1', '0.7.2');

    // Should include 0.7.2 (toVersion), exclude 0.7.1 (fromVersion)
    expect(diff).toHaveLength(1);
    expect(diff[0].version).toBe('0.7.2');
  });

  it('should return empty when fromVersion is not older than toVersion', () => {
    const content = `# Changelog
## [0.7.2] - 2025-03-05
### Added
- Feature B

## [0.7.1] - 2025-03-01
### Added
- Feature A
`;
    const diff = getChangelogDiff(content, '0.7.2', '0.7.1');

    expect(diff).toEqual([]);
  });
});
