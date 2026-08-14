import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AppSetupArtifactSchema } from '../contracts/app-setup.js';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
} from '../codegen/execution-inventory.js';
import { writeNextAppRouteScan } from '../codegen/route-scanner.js';
import {
  buildManifests,
  validateWorkspace,
} from './commands/validate-build.js';
import { AppSetupClient } from '../sync/app-setup-client.js';
import {
  installSkills,
  type InstallSkillsOptions,
} from './commands/install-skills.js';
import {
  parseLocalExecutionInventory,
  RuntimeSetupClient,
  type RouteScanUpload,
} from '../sync/runtime-setup-client.js';
import { type InstallerPart } from './commands/installer-parts.js';
import {
  defaultWizardDependencies,
  runSetupWizard,
  WizardStopped,
  type AssessmentMode,
  type InstallHost,
} from './commands/setup-wizard.js';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import {
  assertSetupPlanConfirmation,
  createSetupPlan,
} from './commands/setup-plan.js';
import { applySetupPlan } from './commands/apply-setup-plan.js';

type CommandName = 'scan' | 'setup' | 'install' | 'validate' | 'build';

export interface CliDependencies {
  ask?: (question: string) => Promise<string>;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseCommand(args: string[]): {
  command: CommandName;
  rest: string[];
} {
  const [command, ...rest] = args;
  if (
    command !== 'scan'
    && command !== 'setup'
    && command !== 'install'
    && command !== 'validate'
    && command !== 'build'
  ) {
    throw new Error(
      'Usage: glirastes setup\n'
      + '         the guided flow: it asks, then installs, scans, assesses, '
      + 'validates and syncs\n'
      + '       glirastes setup <scan|sync|status> [options]\n'
      + '         the same steps, one at a time\n'
      + '       glirastes scan [--output] [--sync] [--execution-inventory]\n'
      + '       glirastes install [--host a,b] [--symlink] [--force] '
      + '[--dry-run]\n'
      + '       glirastes validate [--root] [--app-id]\n'
      + '       glirastes build [--root] [--app-id] [--output]\n',
    );
  }
  return { command, rest };
}

async function terminalAsk(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive input is unavailable. Pass --with-setup-skills or '
      + '--without-setup-skills and --host when required.',
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

function parseHost(value: string | undefined): InstallSkillsOptions['host'] {
  if (value === undefined) return undefined;
  if (value === 'codex' || value === 'claude' || value === 'gemini') {
    return value;
  }
  throw new Error('Choose a host: codex, claude, or gemini.');
}

/** `--host claude,codex` — several agent hosts share one install. */
function parseHosts(
  value: string | undefined,
): InstallHost[] | undefined {
  if (value === undefined) return undefined;
  const hosts = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = parseHost(entry);
      if (!parsed) throw new Error('Choose a host: codex, claude, or gemini.');
      return parsed;
    });
  return hosts.length > 0 ? [...new Set(hosts)] : undefined;
}

async function runInstall(
  rest: string[],
  dependencies: CliDependencies,
): Promise<void> {
  if (
    hasFlag(rest, '--with-setup-skills')
    && hasFlag(rest, '--without-setup-skills')
  ) {
    throw new Error(
      'Choose either --with-setup-skills or --without-setup-skills.',
    );
  }
  const ask = dependencies.ask ?? terminalAsk;
  let includeSetupSkills = hasFlag(rest, '--with-setup-skills');
  if (
    !includeSetupSkills
    && !hasFlag(rest, '--without-setup-skills')
  ) {
    const consent = (await ask(
      'Install the optional local Glirastes setup skills? [y/N] ',
    )).trim().toLowerCase();
    if (!['y', 'yes', 'n', 'no', ''].includes(consent)) {
      throw new Error('Answer yes or no for setup skills.');
    }
    includeSetupSkills = consent === 'y' || consent === 'yes';
  }

  let hosts = parseHosts(getFlagValue(rest, '--host'));
  if (includeSetupSkills && !hosts) {
    hosts = parseHosts((await ask(
      'Choose the setup hosts (codex, claude, gemini; comma-separated): ',
    )).trim().toLowerCase());
  }

  await installSkills({
    rootDir: getFlagValue(rest, '--root') ?? process.cwd(),
    target: getFlagValue(rest, '--target'),
    global: hasFlag(rest, '--global'),
    symlink: hasFlag(rest, '--symlink'),
    force: hasFlag(rest, '--force'),
    dryRun: hasFlag(rest, '--dry-run'),
    includeSetupSkills,
    hosts,
  });
}

function setupConnection(rest: string[]): {
  baseUrl: string;
  appId: string;
  setupApiKey: string;
} {
  const baseUrl = getFlagValue(rest, '--base-url')
    ?? process.env.GLIRASTES_CONTROL_PLANE_URL;
  const appId = getFlagValue(rest, '--app-id')
    ?? process.env.GLIRASTES_APP_ID;
  // One key, one variable: GLIRASTES_API_KEY.
  const setupApiKey = process.env.GLIRASTES_API_KEY;
  if (!baseUrl) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-001',
      operation: 'setup.connection',
      message: 'GLIRASTES_CONTROL_PLANE_URL is not configured for setup.',
      remediation: 'configure-control-plane-url',
    });
  }
  if (!appId) {
    throw new FoundationDiagnosticError({
      code: 'E-SCOPE-001',
      operation: 'setup.connection',
      message: 'GLIRASTES_APP_ID is not configured for setup.',
      remediation: 'configure-app-id',
    });
  }
  if (!setupApiKey) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-002',
      operation: 'setup.connection',
      message: 'GLIRASTES_API_KEY is not configured for setup.',
      remediation: 'configure-app-api-key',
    });
  }
  return { baseUrl, appId, setupApiKey };
}

/**
 * Bare `glirastes setup` — carries a fresh app from nothing to a synced setup
 * run by delegating to the same steps the sub-commands expose. It adds no second
 * implementation of any of them.
 */
async function runSetupWizardCommand(rest: string[]): Promise<void> {
  const rootDir = resolve(getFlagValue(rest, '--root') ?? process.cwd());
  try {
    const artifactPath = artifactPathFrom(rest);
    if (existsSync(join(rootDir, artifactPath))) {
      const plan = await createSetupPlan({
        rootDir,
        artifactPath,
        previousArtifactPath: getFlagValue(rest, '--previous-artifact'),
      });
      assertSetupPlanConfirmation(plan, {
        confirmLoosening: hasFlag(rest, '--confirm-loosening'),
        planDigest: getFlagValue(rest, '--plan-digest'),
      });
    }
    await runSetupWizard({
      rootDir,
      io: {
        isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        log: (message) => { console.log(message); },
        ask: terminalAsk,
      },
      hosts: parseHosts(getFlagValue(rest, '--host')),
      assessmentMode: parseAssessmentMode(
        getFlagValue(rest, '--assessment'),
      ),
      deps: {
        ...defaultWizardDependencies(),
        discover: async (root) => {
          await runSetup(['scan', '--root', root, '--quiet']);
          const discovery = JSON.parse(readFileSync(
            join(root, '.glirastes/setup-discovery.json'),
            'utf8',
          )) as { executions?: unknown[] };
          return { executionCount: discovery.executions?.length ?? 0 };
        },
        assessmentArtifactExists: async (root) =>
          existsSync(join(root, artifactPathFrom(rest))),
        validate: async (root) => {
          const appId = getFlagValue(rest, '--app-id');
          if (!appId) {
            throw new Error('--app-id is required to validate the workspace.');
          }
          await validateWorkspace({ rootDir: root, appId });
        },
        sync: async (root) => {
          await runSetup([
            'sync',
            '--root', root,
            '--artifact', artifactPathFrom(rest),
            ...connectionFlags(rest),
          ]);
          const artifact = JSON.parse(readFileSync(
            join(root, artifactPathFrom(rest)),
            'utf8',
          )) as { runId: string };
          return { runId: artifact.runId };
        },
      },
    });
  } catch (error) {
    if (error instanceof WizardStopped) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function artifactPathFrom(rest: string[]): string {
  return getFlagValue(rest, '--artifact')
    ?? '.glirastes/app-setup-artifact.json';
}

/** Pass the connection flags through to `setup sync` untouched. */
function connectionFlags(rest: string[]): string[] {
  const passed: string[] = [];
  for (const flag of ['--base-url', '--app-id', '--environment-id']) {
    const value = getFlagValue(rest, flag);
    if (value) passed.push(flag, value);
  }
  return passed;
}

function parseAssessmentMode(
  value: string | undefined,
): AssessmentMode | undefined {
  if (value === undefined) return undefined;
  if (
    value !== 'interview'
    && value !== 'autonomous'
    && value !== 'manual'
  ) {
    throw new Error(
      `Unknown --assessment value: '${value}'. `
      + 'Use interview, autonomous, or manual.',
    );
  }
  return value;
}

async function runSetup(rest: string[]): Promise<void> {
  if (hasFlag(rest, '--dry-run')) {
    const rootDir = resolve(getFlagValue(rest, '--root') ?? process.cwd());
    const plan = await createSetupPlan({
      rootDir,
      artifactPath: getFlagValue(rest, '--artifact'),
      previousArtifactPath: getFlagValue(rest, '--previous-artifact'),
      inventoryPath: getFlagValue(rest, '--execution-inventory'),
      promptBundlePath: getFlagValue(rest, '--prompt-bundle'),
      managed: hasFlag(rest, '--managed'),
    });
    if (hasFlag(rest, '--json')) {
      console.log(JSON.stringify(plan));
    } else {
      console.log(
        `Setup plan ${plan.planDigest}: ${plan.operations.length} operations, `
        + `${plan.counts.tools} tools, confirmation `
        + `${plan.requiresConfirmation ? 'required' : 'not required'}.`,
      );
    }
    return;
  }
  if (rest[0] === 'guided') {
    await runSetupWizardCommand(rest.slice(1));
    return;
  }
  if (rest[0] === undefined || rest[0]?.startsWith('--')) {
    const rootDir = resolve(getFlagValue(rest, '--root') ?? process.cwd());
    const plan = await createSetupPlan({
      rootDir,
      artifactPath: getFlagValue(rest, '--artifact'),
      previousArtifactPath: getFlagValue(rest, '--previous-artifact'),
      inventoryPath: getFlagValue(rest, '--execution-inventory'),
      promptBundlePath: getFlagValue(rest, '--prompt-bundle'),
      managed: hasFlag(rest, '--managed'),
    });
    assertSetupPlanConfirmation(plan, {
      confirmLoosening: hasFlag(rest, '--confirm-loosening'),
      planDigest: getFlagValue(rest, '--plan-digest'),
    });
    const applied = await applySetupPlan({ rootDir, plan });
    if (applied.mode === 'managed') {
      await runSetup([
        'sync',
        '--root', rootDir,
        '--artifact', '.glirastes/setup-artifact.json',
        '--app-id', applied.appId,
        ...connectionFlags(rest),
        '--quiet',
      ]);
    }
    if (hasFlag(rest, '--json')) {
      console.log(JSON.stringify({ schemaVersion: 1, ...applied }));
    } else {
      console.log('Glirastes setup');
      console.log(`  ${applied.toolCount} tools validated`);
      console.log(`  ${applied.mode === 'standalone' ? 'Standalone' : 'Managed'} artifacts installed`);
      console.log('  Security policy unchanged');
      console.log('');
      console.log('Restart the application, then run: glirastes doctor');
    }
    return;
  }
  const [subcommand, ...options] = rest;
  const rootDir = getFlagValue(options, '--root') ?? process.cwd();
  const quiet = hasFlag(options, '--quiet');

  if (subcommand === 'scan') {
    const inventoryPath = resolve(
      rootDir,
      getFlagValue(options, '--execution-inventory')
        ?? '.glirastes/local-execution-inventory.v2.json',
    );
    const inventory = FoundationExecutionInventorySchema.parse(JSON.parse(
      readFileSync(inventoryPath, 'utf8'),
    ));
    const discovery = await discoverFoundationExecutions({
      rootDir,
      inventory,
    });
    const outputPath = resolve(
      rootDir,
      getFlagValue(options, '--output')
        ?? '.glirastes/setup-discovery.json',
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify(discovery, null, 2)}\n`,
      'utf8',
    );
    if (!quiet) {
      console.log(
        `Discovered ${discovery.executions.length} local executions to `
        + outputPath,
      );
    }
    return;
  }

  const connection = setupConnection(options);
  const client = new AppSetupClient(connection);
  if (subcommand === 'status') {
    const runId = getFlagValue(options, '--run-id');
    if (!runId) {
      throw new Error('--run-id is required for setup status.');
    }
    const run = await client.getRun(runId);
    if (!quiet) {
      console.log(
        `Setup run ${run.runId}: ${run.status}`,
      );
    }
    return;
  }

  const artifactPath = getFlagValue(options, '--artifact');
  if (!artifactPath) {
    throw new Error('--artifact is required for setup sync.');
  }
  const artifact = AppSetupArtifactSchema.parse(JSON.parse(
    readFileSync(resolve(rootDir, artifactPath), 'utf8'),
  ));
  if (artifact.appId !== connection.appId) {
    throw new Error('App setup artifact targets a different app');
  }
  await client.createRun({
    runId: artifact.runId,
    assessmentMode: artifact.assessmentMode,
    discoveryDigest: artifact.discoveryDigest,
  });
  const run = await client.uploadArtifact(artifact);
  if (!quiet) {
    console.log(`Synced setup run ${run.runId}: ${run.status}`);
  }
}

async function runLegacyScan(rest: string[]): Promise<void> {
  const rootDir = getFlagValue(rest, '--root') ?? process.cwd();
  const quiet = hasFlag(rest, '--quiet');
  let config: { apiDir?: string } = {};
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
    ) as { glirastes?: { apiDir?: string } };
    config = packageJson.glirastes ?? {};
  } catch {
    // The scanner defaults cover projects without package metadata.
  }

  const artifact = await writeNextAppRouteScan({
    rootDir,
    apiDir: config.apiDir,
    outputPath: getFlagValue(rest, '--output'),
  });
  if (!quiet) {
    console.log(
      `Scanned ${artifact.result.candidates.length} route operations to `
      + artifact.outputPath,
    );
  }
  if (!hasFlag(rest, '--sync')) return;

  const baseUrl = getFlagValue(rest, '--base-url')
    ?? process.env.GLIRASTES_CONTROL_PLANE_URL;
  const appId = getFlagValue(rest, '--app-id')
    ?? process.env.GLIRASTES_APP_ID;
  const environmentId = getFlagValue(rest, '--environment-id')
    ?? process.env.GLIRASTES_ENVIRONMENT_ID;
  const apiKey = process.env.GLIRASTES_SETUP_API_KEY;
  if (!baseUrl) {
    throw new Error(
      '--base-url or GLIRASTES_CONTROL_PLANE_URL is required for scan --sync.',
    );
  }
  if (!appId) {
    throw new Error(
      '--app-id or GLIRASTES_APP_ID is required for scan --sync.',
    );
  }
  if (!environmentId) {
    throw new Error(
      '--environment-id or GLIRASTES_ENVIRONMENT_ID is required for scan --sync.',
    );
  }
  if (!apiKey) {
    throw new Error(
      'GLIRASTES_SETUP_API_KEY is required for scan --sync.',
    );
  }

  const scan = JSON.parse(
    readFileSync(artifact.outputPath, 'utf8'),
  ) as RouteScanUpload;
  const executionInventoryPath = getFlagValue(
    rest,
    '--execution-inventory',
  );
  if (executionInventoryPath) {
    scan.executions = parseLocalExecutionInventory(JSON.parse(
      readFileSync(resolve(rootDir, executionInventoryPath), 'utf8'),
    )).executions;
  }

  const imported = await new RuntimeSetupClient({
    baseUrl,
    apiKey,
    appId,
    environmentId,
  }).importRouteScan(scan);
  const bindingsOutput = resolve(
    rootDir,
    getFlagValue(rest, '--bindings-output')
      ?? '.glirastes/platform-tool-bindings.json',
  );
  mkdirSync(dirname(bindingsOutput), { recursive: true });
  writeFileSync(
    bindingsOutput,
    `${JSON.stringify({
      schemaVersion: 1,
      targetAppId: appId,
      environmentId,
      bindings: [...imported.bindings].sort((left, right) => (
        left.stableKey.localeCompare(right.stableKey)
      )),
    }, null, 2)}\n`,
    'utf8',
  );
  if (!quiet) {
    console.log(
      `Imported ${imported.createdDrafts} review drafts; `
      + `${imported.unchanged} unchanged; `
      + `${imported.tombstoneCandidates.length} tombstone candidates.`,
    );
    console.log(`Wrote authoritative tool bindings to ${bindingsOutput}.`);
  }
}

async function runValidate(rest: string[]): Promise<void> {
  const rootDir = getFlagValue(rest, '--root') ?? process.cwd();
  const appId = getFlagValue(rest, '--app-id') ?? process.env.GLIRASTES_APP_ID;
  if (!appId) {
    throw new FoundationDiagnosticError({
      code: 'E-SCOPE-001',
      operation: 'validate.scope',
      message: 'GLIRASTES_APP_ID is not configured for validation.',
      remediation: 'configure-app-id',
    });
  }
  const workspace = await validateWorkspace({
    rootDir,
    appId,
    inventoryPath: getFlagValue(rest, '--execution-inventory'),
    promptBundlePath: getFlagValue(rest, '--prompt-bundle'),
  });
  if (!hasFlag(rest, '--quiet')) {
    console.log(
      `Validated ${workspace.executions.length} executions and the local `
      + 'prompt bundle without network access.',
    );
  }
}

async function runBuild(rest: string[]): Promise<void> {
  const rootDir = getFlagValue(rest, '--root') ?? process.cwd();
  const appId = getFlagValue(rest, '--app-id') ?? process.env.GLIRASTES_APP_ID;
  if (!appId) {
    throw new Error('--app-id or GLIRASTES_APP_ID is required for build.');
  }
  const built = await buildManifests({
    rootDir,
    appId,
    outputDir: getFlagValue(rest, '--output'),
    inventoryPath: getFlagValue(rest, '--execution-inventory'),
    promptBundlePath: getFlagValue(rest, '--prompt-bundle'),
  });
  if (!hasFlag(rest, '--quiet')) {
    console.log(`Runtime manifest ${built.runtimeDigest}`);
    console.log(`Prompt manifest  ${built.promptDigest}`);
  }
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const { command, rest } = parseCommand(args);
  if (command === 'validate') {
    await runValidate(rest);
    return;
  }
  if (command === 'build') {
    await runBuild(rest);
    return;
  }
  if (command === 'install') {
    await runInstall(rest, dependencies);
    return;
  }
  if (command === 'setup') {
    await runSetup(rest);
    return;
  }
  await runLegacyScan(rest);
}
