import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AppSetupArtifactSchema } from '../contracts/app-setup.js';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
} from '../codegen/execution-inventory.js';
import { writeNextAppRouteScan } from '../codegen/route-scanner.js';
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

type CommandName = 'scan' | 'setup' | 'install';

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
  if (command !== 'scan' && command !== 'setup' && command !== 'install') {
    throw new Error(
      'Usage: glirastes scan [--output] [--sync] '
      + '[--execution-inventory]\n'
      + '       glirastes setup <scan|sync|status> [options]\n'
      + '       glirastes install [--with-setup-skills|'
      + '--without-setup-skills] [--host]\n',
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
  throw new Error('Choose exactly one host: codex, claude, or gemini.');
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

  let host = parseHost(getFlagValue(rest, '--host'));
  if (includeSetupSkills && !host) {
    host = parseHost((await ask(
      'Choose exactly one setup host: codex, claude, or gemini: ',
    )).trim().toLowerCase());
  }

  await installSkills({
    rootDir: getFlagValue(rest, '--root') ?? process.cwd(),
    target: getFlagValue(rest, '--target'),
    global: hasFlag(rest, '--global'),
    stack: (getFlagValue(rest, '--stack') ?? 'all') as 'nextjs' | 'all',
    symlink: hasFlag(rest, '--symlink'),
    force: hasFlag(rest, '--force'),
    dryRun: hasFlag(rest, '--dry-run'),
    includeSetupSkills,
    host,
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
  const setupApiKey = process.env.GLIRASTES_SETUP_API_KEY;
  if (!baseUrl) {
    throw new Error(
      '--base-url or GLIRASTES_CONTROL_PLANE_URL is required for setup.',
    );
  }
  if (!appId) {
    throw new Error('--app-id or GLIRASTES_APP_ID is required for setup.');
  }
  if (!setupApiKey) {
    throw new Error('GLIRASTES_SETUP_API_KEY is required for setup.');
  }
  return { baseUrl, appId, setupApiKey };
}

async function runSetup(rest: string[]): Promise<void> {
  const [subcommand, ...options] = rest;
  if (!['scan', 'sync', 'status'].includes(subcommand ?? '')) {
    throw new Error('Usage: glirastes setup <scan|sync|status> [options]\n');
  }
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

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const { command, rest } = parseCommand(args);
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
