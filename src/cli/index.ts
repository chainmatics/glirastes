import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeNextAppRouteScan } from '../codegen/route-scanner.js';
import {
  parseLocalExecutionInventory,
  RuntimeSetupClient,
  type RouteScanUpload,
} from '../sync/runtime-setup-client.js';

type CommandName = 'scan';

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
  if (command !== 'scan') {
    throw new Error(
      'Usage: glirastes scan [--output] [--sync] '
      + '[--execution-inventory]\n',
    );
  }
  return { command, rest };
}

export async function runCli(args: string[]): Promise<void> {
  const { rest } = parseCommand(args);
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
