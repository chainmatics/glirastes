// packages/cli/src/utils/commit-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseCommits, type ParsedCommit } from './commit-parser';

describe('parseCommits', () => {
  it('should parse conventional commits', () => {
    const commits = [
      'feat(codegen): add relatedModules generation',
      'fix(chat-react): consolidate duplicate bubbles',
      'chore: update dependencies',
      'docs: update README',
    ];

    const parsed = parseCommits(commits);

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({
      type: 'feat',
      scope: 'codegen',
      description: 'add relatedModules generation',
      breaking: false,
    });
    expect(parsed[1].type).toBe('fix');
    expect(parsed[2].type).toBe('chore');
  });

  it('should detect breaking changes', () => {
    const commits = [
      'feat(api)!: change authentication response format',
      'feat: something\n\nBREAKING CHANGE: ModelTier enum renamed',
    ];

    const parsed = parseCommits(commits);

    expect(parsed[0].breaking).toBe(true);
    expect(parsed[1].breaking).toBe(true);
  });

  it('should ignore malformed commits', () => {
    const commits = [
      'not a conventional commit',
      'feat(scope): valid commit',
      'another bad one',
    ];

    const parsed = parseCommits(commits);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('feat');
  });
});
