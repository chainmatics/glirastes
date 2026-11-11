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

  it('runs on every environment branch asked for and opens the pull request against that branch', () => {
    const workflow = githubToolsWorkflow({ packageManager: 'bun', enrichOn: ['staging', 'release/next'] });
    const enrich = job(workflow, 'glirastes-tools-enrich');

    expect(workflow).toContain("  push:\n    branches: [main, staging, 'release/next']\n");
    expect(enrich).toContain("|| (github.event_name == 'push' && (github.ref == 'refs/heads/staging' || github.ref == 'refs/heads/release/next'))");
    expect(enrich).toContain('      contents: write\n      pull-requests: write\n');
    // The branch name reaches the shell through the environment, never through the script text.
    expect(enrich).toContain('      - run: bunx glirastes tools enrich --managed --json --base "$GLIRASTES_BASE_BRANCH"\n');
    expect(enrich).toContain('          GLIRASTES_BASE_BRANCH: ${{ github.base_ref || github.ref_name }}\n');
    expect(githubToolsWorkflow({ packageManager: 'bun', enrichOn: ['main'] }))
      .toBe(githubToolsWorkflow({ packageManager: 'bun', enrichOnMain: true }));
  });

  it('compares a push with the commit before it and works the backlog only on a manual start', () => {
    const workflow = githubToolsWorkflow({ packageManager: 'bun', enrichOn: ['staging'] });
    const enrich = job(workflow, 'glirastes-tools-enrich');

    expect(workflow).toContain("  push:\n    branches: [main, staging]\n  workflow_dispatch:\n");
    expect(enrich).toContain("|| github.event_name == 'workflow_dispatch'");
    expect(enrich).toContain('          GLIRASTES_BEFORE_SHA: ${{ github.event.before }}\n');
    expect(enrich).toContain("          GLIRASTES_FIRST_RUN: ${{ github.event_name == 'workflow_dispatch' }}\n");
    // A repository that runs the job on pull requests only has no manual start: the bot could not open a pull request.
    expect(githubToolsWorkflow({ packageManager: 'bun' })).not.toMatch(/workflow_dispatch|GLIRASTES_FIRST_RUN|GLIRASTES_BEFORE_SHA/);
  });

  it('refuses a branch name that is not one', async () => {
    await expect(writeCiWorkflow({ root, provider: 'github', enrichOn: ['staging', 'a b'] }))
      .rejects.toEqual(new CiWorkflowError('ci_branch_invalid'));
    await expect(writeCiWorkflow({ root, provider: 'github', enrichOn: ["x' || true"] }))
      .rejects.toEqual(new CiWorkflowError('ci_branch_invalid'));
  });

  it('takes the environment branches from --enrich-on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCli(['init', '--ci', 'github', '--enrich-on', 'staging,main', '--root', root, '--json'], { init: { ask: vi.fn() } as never });

    expect(await readFile(join(root, CI_WORKFLOW_PATH), 'utf8'))
      .toBe(githubToolsWorkflow({ packageManager: 'npm', enrichOn: ['staging', 'main'] }));
  });

  it("reads the managed job's keys from a GitHub environment on request", () => {
    const workflow = githubToolsWorkflow({ packageManager: 'bun', enrichOn: ['staging'], environment: 'staging' });
    const enrich = job(workflow, 'glirastes-tools-enrich');
    const steps = enrich.slice(enrich.indexOf('    steps:\n'));

    expect(enrich).toContain('    environment: staging\n');
    expect(workflow).toContain('# GLIRASTES_MANAGED_TOOLS of the GitHub environment staging is "true"');
    // A job-level `if` cannot see environment variables, so every step checks the switch.
    expect(enrich).not.toContain("vars.GLIRASTES_MANAGED_TOOLS == 'true' && (");
    expect(steps.match(/      - (uses|run): /g)).toHaveLength(5);
    expect(steps.match(/        if: vars.GLIRASTES_MANAGED_TOOLS == 'true'\n/g)).toHaveLength(5);
    expect(job(workflow, 'glirastes-tools')).not.toMatch(/environment|vars\./);
    expect(githubToolsWorkflow({ packageManager: 'bun', enrichOn: ['staging'] })).not.toContain('environment:');
  });

  it('refuses an environment name that is not one', async () => {
    await expect(writeCiWorkflow({ root, provider: 'github', environment: "x' || true" }))
      .rejects.toEqual(new CiWorkflowError('ci_environment_invalid'));
  });

  it('takes the environment from --ci-environment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCli(['init', '--ci', 'github', '--enrich-on', 'staging', '--ci-environment', 'staging', '--root', root, '--json'], { init: { ask: vi.fn() } as never });

    expect(await readFile(join(root, CI_WORKFLOW_PATH), 'utf8'))
      .toBe(githubToolsWorkflow({ packageManager: 'npm', enrichOn: ['staging'], environment: 'staging' }));
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
