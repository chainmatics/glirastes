import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  PlatformConnectionDescriptorSchema,
  type PlatformConnectionDescriptor,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/foundation-diagnostic.js';
import {
  type AtomicArtifactWriteHooks,
  writeArtifactSetAtomically,
} from './atomic-artifact-write.js';
import {
  connectionDescriptorPath,
  renderConnectionDescriptor,
  validateConnectionTargetPath,
} from './connection-descriptor.js';

const execFileAsync = promisify(execFile);
const variableNames = [
  'GLIRASTES_CONTROL_PLANE_URL',
  'GLIRASTES_APP_ID',
  'GLIRASTES_ENVIRONMENT_ID',
  'GLIRASTES_RUNNER_KEY',
  'GLIRASTES_API_KEY',
] as const;

type ConnectionVariable = typeof variableNames[number];

export interface ConnectionEnvironmentPreflightOptions {
  projectRoot: string;
  framework: 'nextjs';
  environmentPath?: string;
  descriptorPath?: string;
  isGitIgnored?: (path: string, projectRoot: string) => Promise<boolean>;
}

export interface ConnectionEnvironmentTargets {
  projectRoot: string;
  environmentPath: string;
  descriptorPath: string;
}

export interface MaterializeConnectionEnvironmentOptions
  extends ConnectionEnvironmentPreflightOptions {
  connection: PlatformConnectionDescriptor;
  apiKey: string;
  atomicWriteHooks?: AtomicArtifactWriteHooks;
}

async function defaultIsGitIgnored(
  path: string,
  projectRoot: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['check-ignore', '--quiet', '--', relative(projectRoot, path)],
      { cwd: projectRoot },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) {
      return false;
    }
    throw error;
  }
}

export async function preflightConnectionEnvironment(
  options: ConnectionEnvironmentPreflightOptions,
): Promise<ConnectionEnvironmentTargets> {
  if (options.framework !== 'nextjs') {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-FRAMEWORK-UNSUPPORTED',
      operation: 'connect',
      message: 'Automatic secret materialization currently requires Next.js.',
      remediation: 'configure-supported-secret-target',
    });
  }
  const projectRoot = resolve(options.projectRoot);
  const environmentPath = await validateConnectionTargetPath(
    projectRoot,
    options.environmentPath ?? resolve(projectRoot, '.env.local'),
  );
  const descriptorPath = await validateConnectionTargetPath(
    projectRoot,
    options.descriptorPath ?? connectionDescriptorPath(projectRoot),
  );
  const isGitIgnored = options.isGitIgnored ?? defaultIsGitIgnored;
  if (!await isGitIgnored(environmentPath, projectRoot)) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-SECRET-TRACKED',
      operation: 'connect',
      message: 'The local connection secret target is not ignored by Git.',
      remediation: 'ignore-env-local',
      path: relative(projectRoot, environmentPath),
    });
  }
  return { projectRoot, environmentPath, descriptorPath };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function renderEnvironment(
  existing: string,
  values: Record<ConnectionVariable, string>,
): string {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = existing.endsWith('\n');
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const found = new Map<ConnectionVariable, number>();
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !variableNames.includes(match[1] as ConnectionVariable)) {
      continue;
    }
    const name = match[1] as ConnectionVariable;
    if (found.has(name)) {
      throw new FoundationDiagnosticError({
        code: 'E-CONNECT-ENV-DUPLICATE',
        operation: 'connect',
        message: 'The local secret file contains a duplicate connection variable.',
        remediation: 'deduplicate-connection-variables',
        identifier: name,
      });
    }
    found.set(name, index);
  }

  for (const name of variableNames) {
    const rendered = `${name}=${values[name]}`;
    const index = found.get(name);
    if (index === undefined) lines.push(rendered);
    else lines[index] = rendered;
  }
  const output = lines.join(newline);
  return `${output}${hadFinalNewline || existing === '' ? newline : ''}`;
}

export async function materializeConnectionEnvironment(
  options: MaterializeConnectionEnvironmentOptions,
): Promise<{ descriptorPath: string; environmentPath: string }> {
  const targets = await preflightConnectionEnvironment(options);
  const connection = PlatformConnectionDescriptorSchema.parse(options.connection);
  if (!/^gl_[A-Za-z0-9]{32,128}$/.test(options.apiKey)) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-CREDENTIAL-INVALID',
      operation: 'connect',
      message: 'The one-time connection credential is invalid.',
      remediation: 'restart-browser-pairing',
    });
  }

  const existing = await readOptional(targets.environmentPath);
  const secretBuffer = Buffer.from(renderEnvironment(existing, {
    GLIRASTES_CONTROL_PLANE_URL: connection.baseUrl,
    GLIRASTES_APP_ID: connection.appId,
    GLIRASTES_ENVIRONMENT_ID: connection.environmentId,
    GLIRASTES_RUNNER_KEY: connection.runnerKey,
    GLIRASTES_API_KEY: options.apiKey,
  }));
  try {
    await writeArtifactSetAtomically([
      {
        path: targets.descriptorPath,
        content: renderConnectionDescriptor(connection),
      },
      { path: targets.environmentPath, content: secretBuffer },
    ], options.atomicWriteHooks);
  } finally {
    secretBuffer.fill(0);
  }
  return {
    descriptorPath: targets.descriptorPath,
    environmentPath: targets.environmentPath,
  };
}
