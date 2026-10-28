import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../index.js';
import {
  CI_WORKFLOW_PATH,
  CiWorkflowError,
  detectPackageManager,
  githubToolsWorkflow,
  writeCiWorkflow,
} from './ci-workflow.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glirastes-ci-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The lines of one job, from its key to the next job or the end. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('glirastes init --ci github', () => {
  it('keeps the check job free of secrets, models and write access', () => {
    const workflow = githubToolsWorkflow({ packageManager: 'bun', enrichOnMain: false });
    const check = job(workflow, 'glirastes-tools');

    expect(workflow).toContain('permissions:\n  contents: read\n');
    expect(check).toContain('      - run: bunx glirastes tools check --json\n');
    expect(check).toContain('      - run: bunx glirastes tools eval\n');
    expect(check).not.toMatch(/secrets\.|enrich|permissions|OPENROUTER/);
  });

  it('runs the managed job only when enabled, below the key lifetime, with write access to contents only', () => {
    const workflow = githubToolsWorkflow({ packageManager: 'bun', enrichOnMain: false });
    const enrich = job(workflow, 'glirastes-tools-enrich');

    expect(enrich).toContain("vars.GLIRASTES_MANAGED_TOOLS == 'true' && (");
    expect(enrich).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(enrich).not.toContain("github.ref == 'refs/heads/main'");
    expect(enrich).toContain('    timeout-minutes: 50\n');
    expect(enrich).toContain('    permissions:\n      contents: write\n    steps:\n');
    expect(enrich).toContain('          ref: ${{ github.head_ref || github.ref_name }}\n');
    expect(enrich.indexOf('tools refresh --mode write --keep-going')).toBeLessThan(enrich.indexOf('tools enrich --managed --json'));
    expect(enrich).toContain('          GLIRASTES_CI_KEY: ${{ secrets.GLIRASTES_CI_KEY }}\n');
    expect(enrich).toContain('          GLIRASTES_TOOLS_OPENROUTER_KEY: ${{ secrets.GLIRASTES_TOOLS_OPENROUTER_KEY }}\n');
    // The app's chat key stays with the app.
    expect(enrich).not.toContain('OPENROUTER_API_KEY');
    expect(enrich).not.toMatch(/pull-requests|GH_TOKEN/);
  });

  it('adds the main branch with pull request rights only on request', () => {
    const enrich = job(githubToolsWorkflow({ packageManager: 'bun', enrichOnMain: true }), 'glirastes-tools-enrich');

    expect(enrich).toContain("|| (github.event_name == 'push' && github.ref == 'refs/heads/main')");
    expect(enrich).toContain('      contents: write\n      pull-requests: write\n');
    expect(enrich).toContain('          GH_TOKEN: ${{ github.token }}\n');
  });

  it('uses the package manager of the lockfile', async () => {
    expect(detectPackageManager(root)).toBe('npm');
    expect(githubToolsWorkflow({ packageManager: 'npm', enrichOnMain: false }))
      .toMatch(/run: npm ci\n[\s\S]*run: npx --no-install glirastes tools check --json/);
    await writeFile(join(root, 'yarn.lock'), '');
    expect(detectPackageManager(root)).toBe('yarn');
    await writeFile(join(root, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(root)).toBe('pnpm');
    expect(githubToolsWorkflow({ packageManager: 'pnpm', enrichOnMain: false }))
      .toMatch(/pnpm\/action-setup@v4[\s\S]*run: pnpm install --frozen-lockfile\n[\s\S]*run: pnpm exec glirastes tools eval/);
    await writeFile(join(root, 'bun.lock'), '');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('writes the workflow once, never overwrites a changed one without --force', async () => {
    expect(await writeCiWorkflow({ root, provider: 'github' })).toEqual({ path: CI_WORKFLOW_PATH, status: 'written' });
    expect(await writeCiWorkflow({ root, provider: 'github' })).toEqual({ path: CI_WORKFLOW_PATH, status: 'unchanged' });
    await writeFile(join(root, CI_WORKFLOW_PATH), 'name: edited\n');
    await expect(writeCiWorkflow({ root, provider: 'github' })).rejects.toEqual(new CiWorkflowError('ci_workflow_exists'));
    expect(await readFile(join(root, CI_WORKFLOW_PATH), 'utf8')).toBe('name: edited\n');
    expect(await writeCiWorkflow({ root, provider: 'github', force: true })).toEqual({ path: CI_WORKFLOW_PATH, status: 'replaced' });
    await expect(writeCiWorkflow({ root, provider: 'gitlab' })).rejects.toEqual(new CiWorkflowError('ci_provider_unsupported'));
  });

  it('is what glirastes init --ci github writes, without the agent setup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const init = vi.fn();

    await runCli(['init', '--ci', 'github', '--enrich-on-main', '--root', root, '--json'], { init: { ask: init } as never });

    expect(log.mock.calls).toEqual([[JSON.stringify({ path: CI_WORKFLOW_PATH, status: 'written' })]]);
    expect(await readFile(join(root, CI_WORKFLOW_PATH), 'utf8'))
      .toBe(githubToolsWorkflow({ packageManager: 'npm', enrichOnMain: true }));
    expect(init).not.toHaveBeenCalled();
  });
});
