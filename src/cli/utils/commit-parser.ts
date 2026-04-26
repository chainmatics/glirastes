// packages/cli/src/utils/commit-parser.ts
export interface ParsedCommit {
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
  body?: string;
}

const CONVENTIONAL_COMMIT_REGEX = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)/;

export function parseCommits(commits: string[]): ParsedCommit[] {
  const parsed: ParsedCommit[] = [];

  for (const commit of commits) {
    const lines = commit.split('\n');
    const firstLine = lines[0];
    const body = lines.slice(1).join('\n').trim();

    const match = firstLine.match(CONVENTIONAL_COMMIT_REGEX);
    if (!match) continue; // Ignore malformed commits

    const [, type, scope, exclamation, description] = match;

    const breaking = !!exclamation || body.includes('BREAKING CHANGE:');

    parsed.push({
      type,
      scope,
      description,
      breaking,
      body: body || undefined,
    });
  }

  return parsed;
}
