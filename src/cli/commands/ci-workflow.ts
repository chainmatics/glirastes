import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * `glirastes init --ci github` (spec 4.6, 4.8): the GitHub Actions workflow
 * with the model-free check job `glirastes-tools` and the Pro job
 * `glirastes-tools-enrich`, which stays off until the repository variable
 * GLIRASTES_MANAGED_TOOLS is "true". It runs on pull requests and, on request,
 * after pushes to the branches the environments deploy from.
 */

export const CI_WORKFLOW_PATH = '.github/workflows/glirastes-tools.yml';
/** Below the one-hour lifetime of the job key, so the ledger still arrives. */
export const ENRICH_TIMEOUT_MINUTES = 50;

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export class CiWorkflowError extends Error {
  constructor(readonly code: 'ci_provider_unsupported' | 'ci_workflow_exists' | 'ci_branch_invalid' | 'ci_environment_invalid') {
    super(code === 'ci_provider_unsupported'
      ? 'Only --ci github is supported.'
      : code === 'ci_environment_invalid'
        ? '--ci-environment takes the name of one GitHub environment, for example staging.'
      : code === 'ci_branch_invalid'
        ? '--enrich-on takes branch names separated by commas, for example staging,main.'
        : `${CI_WORKFLOW_PATH} exists with other content; review it or pass --force to replace it.`);
    this.name = 'CiWorkflowError';
  }
}

export function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const SETUP: Record<PackageManager, { steps: string[]; install: string; run: string }> = {
  bun: {
    steps: ['      - uses: oven-sh/setup-bun@v2'],
    install: 'bun install --frozen-lockfile',
    run: 'bunx glirastes',
  },
  pnpm: {
    steps: [
      '      - uses: pnpm/action-setup@v4',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '          cache: pnpm',
    ],
    install: 'pnpm install --frozen-lockfile',
    run: 'pnpm exec glirastes',
  },
  yarn: {
    steps: [
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '          cache: yarn',
    ],
    install: 'yarn install --immutable',
    run: 'yarn glirastes',
  },
  npm: {
    steps: [
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '          cache: npm',
    ],
    install: 'npm ci',
    run: 'npx --no-install glirastes',
  },
};

/** A branch name as git and the Platform accept it; nothing a YAML string or an expression could misread. */
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * The environment branches the managed job also runs on after a push
 * (`--enrich-on staging,main`; `--enrich-on-main` is `main`). There the bot
 * never commits: it opens a pull request against that branch.
 */
export function enrichBranches(options: { enrichOn?: readonly string[]; enrichOnMain?: boolean }): string[] {
  const branches = [...(options.enrichOn ?? []), ...(options.enrichOnMain ? ['main'] : [])];
  if (branches.some((branch) => !BRANCH.test(branch))) throw new CiWorkflowError('ci_branch_invalid');
  return [...new Set(branches)];
}

/** A GitHub environment name that YAML and an expression read literally. */
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,100}$/;

const yamlBranch = (branch: string) => (/^[A-Za-z0-9._-]+$/.test(branch) ? branch : `'${branch}'`);

export function githubToolsWorkflow(options: {
  packageManager: PackageManager;
  enrichOnMain?: boolean;
  enrichOn?: readonly string[];
  /**
   * The GitHub environment whose secrets and variables the managed job reads
   * (`--ci-environment staging`), so a staging Platform's CI key never sits
   * beside production's repository values. A job-level `if` cannot see
   * environment variables, so every step checks GLIRASTES_MANAGED_TOOLS.
   */
  environment?: string;
}): string {
  const setup = SETUP[options.packageManager];
  const branches = enrichBranches(options);
  const environment = options.environment;
  if (environment !== undefined && !ENVIRONMENT.test(environment)) throw new CiWorkflowError('ci_environment_invalid');
  const gated = (steps: string[]) => (environment === undefined ? steps : steps.flatMap((line) => (
    /^      - /.test(line) ? [line, "        if: vars.GLIRASTES_MANAGED_TOOLS == 'true'"] : [line]
  )));
  const onPush = branches.length > 0;
  const refs = branches.map((branch) => `github.ref == 'refs/heads/${branch}'`).join(' || ');
  const trigger = onPush
    ? "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)\n"
      + `        || (github.event_name == 'push' && ${branches.length > 1 ? `(${refs})` : refs})`
    : "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";
  const pushBranches = [...new Set(['main', ...branches])].map(yamlBranch).join(', ');
  return [
    '# Written by `glirastes init --ci github`.',
    '# glirastes-tools checks the committed tool outputs without secrets or models.',
    '# glirastes-tools-enrich (Glirastes Pro) describes open tools in a managed job and',
    ...(environment === undefined
      ? [
        '# commits them as glirastes-bot; it runs once the repository variable',
        '# GLIRASTES_MANAGED_TOOLS is "true" and the secret GLIRASTES_CI_KEY is set.',
      ]
      : [
        '# commits them as glirastes-bot; it runs once the variable',
        `# GLIRASTES_MANAGED_TOOLS of the GitHub environment ${environment} is "true" and`,
        '# that environment holds GLIRASTES_CI_KEY and GLIRASTES_CONTROL_PLANE_URL.',
      ]),
    'name: glirastes-tools',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    `    branches: [${pushBranches}]`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  glirastes-tools:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...setup.steps,
    `      - run: ${setup.install}`,
    `      - run: ${setup.run} tools check --json`,
    `      - run: ${setup.run} tools eval`,
    '',
    '  glirastes-tools-enrich:',
    '    if: >-',
    ...(environment === undefined
      ? ["      vars.GLIRASTES_MANAGED_TOOLS == 'true' && (", `        ${trigger}`, '      )']
      : [`      ${trigger.replace('\n        ', '\n      ')}`]),
    ...(environment === undefined ? [] : [`    environment: ${environment}`]),
    '    runs-on: ubuntu-latest',
    `    timeout-minutes: ${ENRICH_TIMEOUT_MINUTES}`,
    '    concurrency:',
    '      group: glirastes-tools-enrich-${{ github.head_ref || github.ref_name }}',
    '      cancel-in-progress: false',
    '    permissions:',
    '      contents: write',
    ...(onPush ? ['      pull-requests: write'] : []),
    '    steps:',
    ...gated([
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.head_ref || github.ref_name }}',
      ...setup.steps,
      `      - run: ${setup.install}`,
      `      - run: ${setup.run} tools refresh --mode write --keep-going`,
      `      - run: ${setup.run} tools enrich --managed --json${onPush ? ' --base "$GLIRASTES_BASE_BRANCH"' : ''}`,
    ]),
    '        env:',
    '          GLIRASTES_CI_KEY: ${{ secrets.GLIRASTES_CI_KEY }}',
    '          GLIRASTES_CONTROL_PLANE_URL: ${{ vars.GLIRASTES_CONTROL_PLANE_URL }}',
    '          GLIRASTES_TOOLS_OPENROUTER_KEY: ${{ secrets.GLIRASTES_TOOLS_OPENROUTER_KEY }}',
    ...(onPush ? [
      // A pull request names its target, a push its own branch: there the bot opens a pull request.
      '          GLIRASTES_BASE_BRANCH: ${{ github.base_ref || github.ref_name }}',
      '          GH_TOKEN: ${{ github.token }}',
    ] : []),
    '',
  ].join('\n');
}

export async function writeCiWorkflow(options: {
  root: string;
  provider: string;
  enrichOnMain?: boolean;
  enrichOn?: readonly string[];
  environment?: string;
  force?: boolean;
}): Promise<{ path: string; status: 'written' | 'unchanged' | 'replaced' }> {
  if (options.provider !== 'github') throw new CiWorkflowError('ci_provider_unsupported');
  const content = githubToolsWorkflow({
    packageManager: detectPackageManager(options.root),
    enrichOnMain: options.enrichOnMain === true,
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.enrichOn ? { enrichOn: options.enrichOn } : {}),
  });
  const target = join(options.root, CI_WORKFLOW_PATH);
  const existing = await readFile(target, 'utf8').catch(() => undefined);
  if (existing === content) return { path: CI_WORKFLOW_PATH, status: 'unchanged' };
  if (existing !== undefined && !options.force) throw new CiWorkflowError('ci_workflow_exists');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return { path: CI_WORKFLOW_PATH, status: existing === undefined ? 'written' : 'replaced' };
}
