import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isFoundationDiagnosticError } from '../../diagnostics/index.js';
import type { RenderedManifests } from './validate-build.js';
import { detectSetupProfile } from './setup-profile.js';
import { createSetupPlan } from './setup-plan.js';
import { renderCurrentSetupManifests } from './current-setup-manifests.js';
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
  let profile: Awaited<ReturnType<typeof detectSetupProfile>>;
  try {
    profile = await detectSetupProfile({ rootDir, managed: options.managed });
    checks.push(check('project', 'pass', 'E-SETUP-100'));
  } catch (error) {
    checks.push(check(
      'project',
      'fail',
      failureCode(error, 'E-SETUP-007'),
      'repair-local-project-profile',
    ));
    return finish(mode, 0, checks);
  }

  checks.push(profile.framework
    ? check('framework', 'pass', 'E-SETUP-101')
    : check('framework', 'warn', 'E-SETUP-102', 'declare-supported-framework'));
  checks.push(profile.authProviders.length > 0
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
      'repair-local-artifacts',
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
      const current = receipt.planDigest === plan.planDigest
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
  if (mode !== 'standalone') {
    let descriptor: Awaited<ReturnType<typeof readPlatformConnectionDescriptor>> | undefined;
    let credentials: Awaited<ReturnType<typeof loadConnectionCredentials>> | undefined;
    try {
      descriptor = await readPlatformConnectionDescriptor(rootDir);
      checks.push(check('connection-descriptor', 'pass', 'E-CONNECT-100'));
    } catch {
      checks.push(check(
        'connection-descriptor',
        'fail',
        'E-CONNECT-001',
        'rerun-connect',
      ));
    }
    try {
      credentials = await loadConnectionCredentials({
        rootDir,
        env: options.env,
        isGitIgnored: options.isGitIgnored,
        requireLocalSecretFile: true,
      });
      checks.push(check('connection-secret-path', 'pass', 'E-CONNECT-101'));
      checks.push(check('connection-credential', 'pass', 'E-CONNECT-102'));
    } catch (error) {
      checks.push(check(
        'connection-secret-path',
        'fail',
        failureCode(error, 'E-CONNECT-002'),
        'repair-ignored-local-secret',
      ));
      checks.push(check(
        'connection-credential',
        'fail',
        'E-CONNECT-003',
        'rerun-connect',
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
  const strayControlPlane = Boolean(env.GLIRASTES_CONTROL_PLANE_URL?.trim());
  const modeValid = mode === 'standalone'
    ? !strayControlPlane
    : connectedValid;
  checks.push(modeValid
    ? check('runtime-mode', 'pass', 'E-SETUP-106')
    : check('runtime-mode', 'fail', 'E-SETUP-009', 'align-explicit-runtime-mode'));

  return finish(mode, profile.toolCount, checks);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Glirastes doctor'];
  for (const item of report.checks) {
    const symbol = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗';
    lines.push(`  ${symbol} ${item.name} (${item.code})`);
  }
  lines.push('');
  lines.push(report.status === 'pass'
    ? `${report.counts.tools} tools ready. Restart the application to activate local changes.`
    : `${report.counts.failed} required checks failed.`);
  return lines.join('\n');
}
