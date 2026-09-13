import type { DoctorReport } from './doctor.js';

const LABELS = new Map([
  ['project', 'Local app setup'],
  ['framework', 'Framework integration'],
  ['auth-provider', 'Sign-in integration'],
  ['principal', 'Signed-in user verification'],
  ['artifacts', 'Local tool configuration'],
  ['build', 'Generated app files'],
  ['receipt', 'Recorded setup version'],
  ['connection-descriptor', 'Selected Platform app and environment'],
  ['connection-secret-path', 'Private local credential storage'],
  ['connection-credential', 'Local connection credentials'],
  ['connection-scope', 'App and environment match'],
  ['runtime-mode', 'Runtime connection settings'],
]);

const NEXT_ACTIONS = new Map([
  ['create-required-setup-artifact',
    'Ask your coding agent to finish the local Glirastes integration using the setting-up-glirastes skill, then run glirastes doctor again.'],
  ['repair-local-project-profile',
    'Run this command from your app folder. Ask your coding agent to check the project configuration if the problem persists.'],
  ['choose-workspace-artifact-path',
    'Ask your coding agent to keep the configured Glirastes files inside this app folder.'],
  ['configure-canonical-artifact-path',
    'Ask your coding agent to select the correct existing Glirastes files in the project configuration. Keep the other files until their purpose is checked.'],
  ['align-local-app-identity',
    'Ask your coding agent to check which app the local Glirastes files belong to. Do not replace their identities just to pass this check.'],
  ['declare-supported-framework',
    'Ask your coding agent to verify the framework integration. Detection alone does not prove the app is supported.'],
  ['review-host-auth-integration',
    'Ask your coding agent to verify how the app signs users in and passes their identity to Glirastes.'],
  ['declare-server-principal',
    'Ask your coding agent to verify the server-side signed-in user integration before declaring it configured. Do not bypass this check.'],
  ['repair-local-artifacts',
    'Ask your coding agent to check the local tool bindings against the current app code, then rerun glirastes setup.'],
  ['repair-missing-ui-handler',
    'Ask your coding agent to restore the UI action handler or regenerate the tool inventory after its removal, then rerun glirastes setup.'],
  ['rerun-local-setup',
    'Run glirastes setup to refresh the local generated files, then run glirastes doctor again.'],
  ['rerun-connect',
    'Check the correct app and environment in the Platform before reconnecting. Keep existing connection files until their scope is verified.'],
  ['repair-ignored-local-secret',
    'Ask your coding agent to check the ignored, project-local credential file. Keep credentials out of Git and chat; do not disable the storage check.'],
  ['align-explicit-runtime-mode',
    'Ask your coding agent to align the local runtime settings with the intended connection. Do not silently switch a connected app to standalone.'],
]);

/** Human output uses fixed copy; machine diagnostics remain available as JSON. */
export function formatDoctorReport(
  report: DoctorReport,
  options: { verbose?: boolean } = {},
): string {
  const lines = ['Glirastes — local setup check'];
  for (const item of report.checks) {
    const symbol = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗';
    const label = LABELS.get(item.name) ?? 'Additional local check';
    const code = /^E-[A-Z]{2,16}-\d{3}$/.test(item.code) ? item.code : 'E-SETUP-999';
    lines.push(`  ${symbol} ${label}${options.verbose ? ` (${code})` : ''}`);
  }
  lines.push('');
  if (report.status === 'fail') {
    lines.push(`${report.counts.failed} required ${report.counts.failed === 1 ? 'check needs' : 'checks need'} attention.`);
  } else {
    lines.push(`Local checks passed for ${report.counts.tools} tools.`);
  }
  if (report.counts.warnings > 0) {
    lines.push(`${report.counts.warnings} ${report.counts.warnings === 1 ? 'warning needs' : 'warnings need'} review.`);
  }
  lines.push('This offline check does not execute a chat or tool action.');
  if (report.mode !== 'standalone') {
    lines.push('It does not confirm Platform connectivity or deployment activation.');
  }

  const issue = report.checks.find((item) => item.status === 'fail')
    ?? report.checks.find((item) => item.status === 'warn');
  const next = issue
    ? NEXT_ACTIONS.get(issue.remediation)
      ?? 'Ask your coding agent to inspect glirastes doctor --json for the required local repair.'
    : report.mode === 'standalone'
      ? 'Restart the application to activate local changes, then try a chat action.'
      : 'Open your app in the Platform to check connection and update status, then try a chat action.';
  const commandMode = report.mode === 'managed' ? ' --managed' : '';
  lines.push(`Next: ${next.replace(/\bglirastes (setup|doctor)\b/g, `$&${commandMode}`)}`);
  if (!options.verbose) {
    lines.push(`Technical details: glirastes doctor${commandMode} --verbose or glirastes doctor${commandMode} --json.`);
  }
  return lines.join('\n');
}
