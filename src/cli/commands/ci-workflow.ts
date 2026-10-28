import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * `glirastes init --ci github` (spec 4.6, 4.8): the GitHub Actions workflow
 * with the model-free check job `glirastes-tools` and the Pro job
 * `glirastes-tools-enrich`, which stays off until the repository variable
 * GLIRASTES_MANAGED_TOOLS is "true".
 */

export const CI_WORKFLOW_PATH = '.github/workflows/glirastes-tools.yml';
/** Below the one-hour lifetime of the job key, so the ledger still arrives. */
export const ENRICH_TIMEOUT_MINUTES = 50;

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export class CiWorkflowError extends Error {
  constructor(readonly code: 'ci_provider_unsupported' | 'ci_workflow_exists') {
    super(code === 'ci_provider_unsupported'
      ? 'Only --ci github is supported.'
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

export function githubToolsWorkflow(options: { packageManager: PackageManager; enrichOnMain: boolean }): string {
  const setup = SETUP[options.packageManager];
  const trigger = options.enrichOnMain
    ? "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)\n"
      + "        || (github.event_name == 'push' && github.ref == 'refs/heads/main')"
    : "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";
  return [
    '# Written by `glirastes init --ci github`.',
    '# glirastes-tools checks the committed tool outputs without secrets or models.',
    '# glirastes-tools-enrich (Glirastes Pro) describes open tools in a managed job and',
    '# commits them as glirastes-bot; it runs once the repository variable',
    '# GLIRASTES_MANAGED_TOOLS is "true" and the secret GLIRASTES_CI_KEY is set.',
    'name: glirastes-tools',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
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
    "      vars.GLIRASTES_MANAGED_TOOLS == 'true' && (",
    `        ${trigger}`,
    '      )',
    '    runs-on: ubuntu-latest',
    `    timeout-minutes: ${ENRICH_TIMEOUT_MINUTES}`,
    '    concurrency:',
    '      group: glirastes-tools-enrich-${{ github.head_ref || github.ref_name }}',
    '      cancel-in-progress: false',
    '    permissions:',
    '      contents: write',
    ...(options.enrichOnMain ? ['      pull-requests: write'] : []),
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.head_ref || github.ref_name }}',
    ...setup.steps,
    `      - run: ${setup.install}`,
    `      - run: ${setup.run} tools refresh --mode write --keep-going`,
    `      - run: ${setup.run} tools enrich --managed --json`,
    '        env:',
    '          GLIRASTES_CI_KEY: ${{ secrets.GLIRASTES_CI_KEY }}',
    '          GLIRASTES_CONTROL_PLANE_URL: ${{ vars.GLIRASTES_CONTROL_PLANE_URL }}',
    '          GLIRASTES_TOOLS_OPENROUTER_KEY: ${{ secrets.GLIRASTES_TOOLS_OPENROUTER_KEY }}',
    ...(options.enrichOnMain ? ['          GH_TOKEN: ${{ github.token }}'] : []),
    '',
  ].join('\n');
}

export async function writeCiWorkflow(options: {
  root: string;
  provider: string;
  enrichOnMain?: boolean;
  force?: boolean;
}): Promise<{ path: string; status: 'written' | 'unchanged' | 'replaced' }> {
  if (options.provider !== 'github') throw new CiWorkflowError('ci_provider_unsupported');
  const content = githubToolsWorkflow({
    packageManager: detectPackageManager(options.root),
    enrichOnMain: options.enrichOnMain === true,
  });
  const target = join(options.root, CI_WORKFLOW_PATH);
  const existing = await readFile(target, 'utf8').catch(() => undefined);
  if (existing === content) return { path: CI_WORKFLOW_PATH, status: 'unchanged' };
  if (existing !== undefined && !options.force) throw new CiWorkflowError('ci_workflow_exists');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return { path: CI_WORKFLOW_PATH, status: existing === undefined ? 'written' : 'replaced' };
}
