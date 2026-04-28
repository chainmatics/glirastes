import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const examples = ['quickstart-nestjs', 'quickstart-nextjs'];
const repoRoot = resolve(__dirname, '..');

describe('examples compile', () => {
  for (const name of examples) {
    it(
      `${name} typechecks against the local source`,
      () => {
        const dir = join(repoRoot, 'examples', name);
        expect(existsSync(dir), `examples/${name} missing`).toBe(true);
        // Throws non-zero exit if tsc finds errors. stderr is captured for assertion message.
        execFileSync('npx', ['tsc', '-p', dir], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      },
      30_000,
    );
  }
});
