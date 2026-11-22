import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isFoundationDiagnosticError } from '../../diagnostics/index.js';
import type { RenderedManifests } from './validate-build.js';
import { detectSetupProfile } from './setup-profile.js';
import {
  acceptsReceiptPlanDigest,
  createSelfSetupPlan,
  createSetupPlan,
} from './setup-plan.js';
import { renderCurrentSetupManifests } from './current-setup-manifests.js';
import { inspectSkillsStaleness, skillsAutoUpdateDisabled } from './skills-auto-update.js';
import { inspectVoiceWorklet } from './voice-worklet-check.js';
export { formatDoctorReport } from './doctor-presentation.js';
import {
  OBSOLETE_CONNECTION_VARIABLES,
  preflightConnectionEnvironment,
  readConnectionSecretSelection,
  type ConnectionSecretSelection,
} from './connection-environment.js';
import {
  assertConnectionScope,
  loadConnectionCredentials,
  readPlatformConnectionDescriptor,
} from './sync.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  code: `E-${string}`;
  remediation: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  status: 'pass' | 'fail';
  mode: 'standalone' | 'connected' | 'managed';
  counts: {
    tools: number;
    passed: number;
    warnings: number;
    failed: number;
  };
  checks: DoctorCheck[];
}

export interface CreateDoctorReportOptions {
  rootDir: string;
  managed?: boolean;
  /** Project-relative, Git-ignored file holding `GLIRASTES_API_KEY`. */
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  isGitIgnored?: (path: string, root: string) => Promise<boolean>;
}

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  planDigest: z.string().startsWith('sha256:'),
  mode: z.enum(['standalone', 'managed']),
  appId: z.uuid(),
  toolCount: z.number().int().nonnegative(),
  runtimeDigest: z.string().startsWith('sha256:'),
  promptDigest: z.string().startsWith('sha256:'),
  restartRequired: z.literal(true),
}).strict();

function check(
  name: string,
  status: DoctorCheckStatus,
  code: `E-${string}`,
  remediation = 'none',
): DoctorCheck {
  return { name, status, code, remediation };
}

function failureCode(error: unknown, fallback: `E-${string}`): `E-${string}` {
  return isFoundationDiagnosticError(error) ? error.code : fallback;
}

function finish(
  mode: 'standalone' | 'connected' | 'managed',
  tools: number,
  checks: DoctorCheck[],
): DoctorReport {
  const passed = checks.filter(({ status }) => status === 'pass').length;
  const warnings = checks.filter(({ status }) => status === 'warn').length;
  const failed = checks.filter(({ status }) => status === 'fail').length;
  return {
    schemaVersion: 1,
    status: failed === 0 ? 'pass' : 'fail',
    mode,
    counts: { tools, passed, warnings, failed },
    checks,
  };
}

/**
 * True when the app, environment or runner variables of older `connect`
 * runs are still set. Names only; values are never read into the report.
 */
async function hasObsoleteConnectionVariables(options: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
  /** The secret file to read, when the app has one. */
  secretFile?: ConnectionSecretSelection;
  isGitIgnored?: (path: string, root: string) => Promise<boolean>;
}): Promise<boolean> {
  if (OBSOLETE_CONNECTION_VARIABLES.some((name) => options.env[name]?.trim())) {
    return true;
  }
  const secretFile = options.secretFile;
  if (!secretFile || (!secretFile.environmentPath && secretFile.framework !== 'nextjs')) {
    return false;
  }
  try {
    const { environmentPath } = await preflightConnectionEnvironment({
      projectRoot: options.rootDir,
      ...(secretFile.framework ? { framework: secretFile.framework } : {}),
      ...(secretFile.environmentPath ? { environmentPath: secretFile.environmentPath } : {}),
      isGitIgnored: options.isGitIgnored,
    });
    if (!environmentPath) return false;
    const raw = await readFile(environmentPath, 'utf8');
    return raw.split(/\r?\n/).some((line) => {
      const name = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1];
      return OBSOLETE_CONNECTION_VARIABLES.includes(
        name as typeof OBSOLETE_CONNECTION_VARIABLES[number],
      );
    });
  } catch {
    // An unreadable or unsafe secret file is reported by the credential checks.
    return false;
  }
}

/** Only for apps that installed skills; stale skills are a hint, not a setup failure. */
async function agentSkillsCheck(rootDir: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck | null> {
  if (skillsAutoUpdateDisabled(env)) return null;
  try {
    const skills = await inspectSkillsStaleness({ rootDir });
    if (!skills) return null;
    if (skills.stale) return check('agent-skills', 'warn', 'E-SETUP-107', 'refresh-agent-skills');
    if (skills.warnings.length > 0) return check('agent-skills', 'warn', 'E-SETUP-107', 'review-edited-agent-skills');
    return check('agent-skills', 'pass', 'E-SETUP-107');
  } catch {
    return check('agent-skills', 'warn', 'E-SETUP-107', 'review-edited-agent-skills');
  }
}

/** Only for apps that use voice input: without the served worklet every recording fails. */
async function voiceWorkletCheck(rootDir: string): Promise<DoctorCheck | null> {
  let inspection: Awaited<ReturnType<typeof inspectVoiceWorklet>>;
  try {
    inspection = await inspectVoiceWorklet(rootDir);
  } catch {
    // An unreadable tree is reported by the project check.
    return null;
  }
  if (!inspection.voice) return null;
  if (inspection.status === 'pass') return check('voice-worklet', 'pass', 'E-SETUP-108');
  if (inspection.status === 'unverifiable') {
    return check('voice-worklet', 'warn', 'E-SETUP-108', 'verify-audio-worklet-url');
  }
  return check('voice-worklet', 'fail', 'E-SETUP-034', 'provide-audio-worklet');
}

export async function createDoctorReport(
  options: CreateDoctorReportOptions,
): Promise<DoctorReport> {
  const rootDir = resolve(options.rootDir);
  let hasConnectionDescriptor = false;
  try {
    await stat(resolve(rootDir, '.glirastes/platform-connection.json'));
    hasConnectionDescriptor = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const mode = options.managed
    ? 'managed'
    : hasConnectionDescriptor ? 'connected' : 'standalone';
  const checks: DoctorCheck[] = [];
  const skillsCheck = await agentSkillsCheck(rootDir, options.env ?? process.env);
  const voiceCheck = await voiceWorkletCheck(rootDir);
  let profile: Awaited<ReturnType<typeof detectSetupProfile>>;
  try {
    profile = await detectSetupProfile({ rootDir, managed: options.managed });
    checks.push(check('project', 'pass', 'E-SETUP-100'));
  } catch (error) {
    checks.push(check(
      'project',
      'fail',
      failureCode(error, 'E-SETUP-007'),
      isFoundationDiagnosticError(error)
        ? error.remediation
        : 'repair-local-project-profile',
    ));
    if (voiceCheck) checks.push(voiceCheck);
    if (skillsCheck) checks.push(skillsCheck);
    return finish(mode, 0, checks);
  }

  checks.push(profile.framework
    ? check('framework', 'pass', 'E-SETUP-101')
    : check('framework', 'warn', 'E-SETUP-102', 'declare-supported-framework'));
  // A declared server-verified principal covers an own sign-in integration
  // (a guard without a known package): nothing is left to review here.
  checks.push(profile.authProviders.length > 0 || profile.principal === 'server-verified'
    ? check('auth-provider', 'pass', 'E-SCOPE-100')
    : check('auth-provider', 'warn', 'E-SCOPE-101', 'review-host-auth-integration'));
  checks.push(profile.principal === 'server-verified'
    ? check('principal', 'pass', 'E-SCOPE-102')
    : check('principal', 'fail', 'E-SCOPE-003', 'declare-server-principal'));

  let rendered: RenderedManifests | undefined;
  let plan: Awaited<ReturnType<typeof createSetupPlan>> | undefined;
  try {
    [rendered, plan] = await Promise.all([
      renderCurrentSetupManifests({
        rootDir,
        managed: Boolean(options.managed),
        profile,
      }),
      createSetupPlan({ rootDir, managed: options.managed }),
    ]);
    checks.push(check('artifacts', 'pass', 'E-SETUP-103'));
  } catch (error) {
    checks.push(check(
      'artifacts',
      'fail',
      failureCode(error, 'E-SETUP-007'),
      isFoundationDiagnosticError(error) ? error.remediation : 'repair-local-artifacts',
    ));
  }

  if (rendered) {
    try {
      const [runtime, prompt] = await Promise.all([
        readFile(resolve(rootDir, profile.paths.buildDir, 'runtime-manifest.json'), 'utf8'),
        readFile(resolve(rootDir, profile.paths.buildDir, 'prompt-manifest.json'), 'utf8'),
      ]);
      checks.push(
        runtime === rendered.runtimeContent && prompt === rendered.promptContent
          ? check('build', 'pass', 'E-SETUP-104')
          : check('build', 'fail', 'E-SETUP-008', 'rerun-local-setup'),
      );
    } catch {
      checks.push(check('build', 'fail', 'E-SETUP-008', 'rerun-local-setup'));
    }
  } else {
    checks.push(check('build', 'fail', 'E-SETUP-008', 'repair-local-artifacts'));
  }

  if (rendered && plan) {
    try {
      const receipt = ReceiptSchema.parse(JSON.parse(await readFile(
        resolve(rootDir, profile.paths.receipt),
        'utf8',
      )));
      // `glirastes setup` records the plan against the previous artifact; the
      // tools generator records the self-plan from committed outputs only.
      const planCurrent = await acceptsReceiptPlanDigest(
        receipt.planDigest,
        plan,
        () => createSelfSetupPlan({ rootDir, managed: options.managed }),
      );
      const current = planCurrent
        && receipt.mode === profile.mode
        && receipt.appId === profile.appId
        && receipt.toolCount === profile.toolCount
        && receipt.runtimeDigest === rendered.runtimeDigest
        && receipt.promptDigest === rendered.promptDigest;
      checks.push(current
        ? check('receipt', 'pass', 'E-SETUP-105')
        : check('receipt', 'fail', 'E-SETUP-010', 'rerun-local-setup'));
    } catch {
      checks.push(check('receipt', 'fail', 'E-SETUP-010', 'rerun-local-setup'));
    }
  } else {
    checks.push(check('receipt', 'fail', 'E-SETUP-010', 'repair-local-artifacts'));
  }

  let connectedValid = false;
  let secretSelection: ConnectionSecretSelection | undefined;
  let selectionError: unknown;
  if (mode !== 'standalone') {
    try {
      secretSelection = await readConnectionSecretSelection({
        projectRoot: rootDir,
        envFile: options.envFile,
      });
    } catch (error) {
      selectionError = error;
    }
  }
  // Without a secret file (no --dotenv, not Next.js) the key lives in the
  // process environment only; there is no file path to check.
  const usesSecretFile = secretSelection === undefined
    || secretSelection.environmentPath !== undefined
    || secretSelection.framework === 'nextjs';
  if (mode !== 'standalone') {
    let descriptor: Awaited<ReturnType<typeof readPlatformConnectionDescriptor>> | undefined;
    let credentials: Awaited<ReturnType<typeof loadConnectionCredentials>> | undefined;
    try {
      descriptor = await readPlatformConnectionDescriptor(rootDir);
      checks.push(check('connection-descriptor', 'pass', 'E-CONNECT-100'));
      if (descriptor.environmentId) {
        checks.push(check(
          'connection-environment-bound',
          'warn',
          'E-CONNECT-105',
          'reconnect-for-app-key',
        ));
      }
    } catch {
      checks.push(check(
        'connection-descriptor',
        'fail',
        'E-CONNECT-001',
        'rerun-connect',
      ));
    }
    try {
      if (selectionError) throw selectionError;
      credentials = await loadConnectionCredentials({
        rootDir,
        envFile: options.envFile,
        env: options.env,
        isGitIgnored: options.isGitIgnored,
        requireLocalSecretFile: true,
      });
      if (usesSecretFile) checks.push(check('connection-secret-path', 'pass', 'E-CONNECT-101'));
      checks.push(check('connection-credential', 'pass', 'E-CONNECT-102'));
    } catch (error) {
      if (selectionError) {
        // tools.json itself is broken: point at it, not at the secret file.
        checks.push(check(
          'connection-secret-path',
          'fail',
          failureCode(error, 'E-CONNECT-002'),
          isFoundationDiagnosticError(error) ? error.remediation : 'repair-tools-config',
        ));
      } else if (usesSecretFile) {
        checks.push(check(
          'connection-secret-path',
          'fail',
          failureCode(error, 'E-CONNECT-002'),
          'repair-ignored-local-secret',
        ));
      }
      checks.push(check(
        'connection-credential',
        'fail',
        'E-CONNECT-003',
        usesSecretFile ? 'rerun-connect' : 'provide-connection-api-key',
      ));
    }
    if (descriptor && credentials) {
      try {
        assertConnectionScope({
          descriptor,
          credentials,
          appId: profile.appId,
        });
        checks.push(check('connection-scope', 'pass', 'E-SCOPE-103'));
        connectedValid = true;
      } catch {
        checks.push(check(
          'connection-scope',
          'fail',
          'E-SCOPE-004',
          'rerun-connect',
        ));
      }
    } else {
      checks.push(check(
        'connection-scope',
        'fail',
        'E-SCOPE-004',
        'rerun-connect',
      ));
    }
  }

  const env = options.env ?? process.env;
  if (await hasObsoleteConnectionVariables({
    rootDir,
    env,
    ...(mode !== 'standalone' && secretSelection ? { secretFile: secretSelection } : {}),
    isGitIgnored: options.isGitIgnored,
  })) {
    checks.push(check(
      'connection-obsolete-variables',
      'warn',
      'E-CONNECT-104',
      'remove-obsolete-connection-variables',
    ));
  }

  // The runtime key is the switch: a standalone app that carries one would
  // start talking to the Platform without a selected app and environment.
  const strayRuntimeKey = Boolean(env.GLIRASTES_API_KEY?.trim());
  const modeValid = mode === 'standalone'
    ? !strayRuntimeKey
    : connectedValid;
  checks.push(modeValid
    ? check('runtime-mode', 'pass', 'E-SETUP-106')
    : check('runtime-mode', 'fail', 'E-SETUP-009', 'align-explicit-runtime-mode'));

  if (voiceCheck) checks.push(voiceCheck);
  if (skillsCheck) checks.push(skillsCheck);
  return finish(mode, profile.toolCount, checks);
}
