import { describe, expect, it } from 'vitest';
import { formatDoctorReport, type DoctorCheck, type DoctorReport } from './doctor.js';

function report(checks: DoctorCheck[], mode: DoctorReport['mode'] = 'standalone'): DoctorReport {
  const failed = checks.filter((item) => item.status === 'fail').length;
  return {
    schemaVersion: 1, mode, status: failed ? 'fail' : 'pass',
    counts: {
      tools: 3, failed,
      passed: checks.filter((item) => item.status === 'pass').length,
      warnings: checks.filter((item) => item.status === 'warn').length,
    },
    checks,
  };
}

describe('Doctor presentation', () => {
  it.each([
    ['create-required-setup-artifact', 'Ask your coding agent'],
    ['rerun-local-setup', 'glirastes setup'],
    ['declare-server-principal', 'server-side'],
    ['rerun-connect', 'correct app and environment'],
    ['repair-ignored-local-secret', 'ignored, project-local'],
  ])('explains the next action for %s', (remediation, expected) => {
    const output = formatDoctorReport(report([
      { name: 'project', status: 'fail', code: 'E-SETUP-005', remediation },
    ]));
    expect(output).toContain(expected);
    expect(output).toContain('Next:');
    expect(output).not.toContain('E-SETUP-005');
    expect(output).not.toContain('tools ready');
  });

  it('prioritizes a failure over an earlier warning and offers one primary next step', () => {
    const output = formatDoctorReport(report([
      { name: 'framework', status: 'warn', code: 'E-SETUP-102', remediation: 'declare-supported-framework' },
      { name: 'principal', status: 'fail', code: 'E-SCOPE-003', remediation: 'declare-server-principal' },
      { name: 'build', status: 'fail', code: 'E-SETUP-008', remediation: 'rerun-local-setup' },
    ]));
    expect(output).toContain('Signed-in user verification');
    expect(output).toContain('Next: Ask your coding agent to verify the server-side');
    expect(output.match(/Next:/g)).toHaveLength(1);
    expect(output).not.toContain('Next: Run');
  });

  it('does not hide warnings behind a ready message', () => {
    const output = formatDoctorReport(report([
      { name: 'framework', status: 'warn', code: 'E-SETUP-102', remediation: 'declare-supported-framework' },
    ]));
    expect(output).toContain('1 warning');
    expect(output).toContain('framework integration');
    expect(output).not.toContain('tools ready');
  });

  it.each(['connected', 'managed'] as const)('does not mistake %s offline checks for activation', (mode) => {
    const output = formatDoctorReport(report([], mode));
    expect(output).toContain('Local checks passed for 3 tools');
    expect(output).toContain('does not confirm Platform connectivity or deployment activation');
    expect(output).not.toContain('Restart the application');
    expect(output).not.toContain('tools ready');
  });

  it('keeps Standalone restart advice without claiming a successful live tool call', () => {
    const output = formatDoctorReport(report([]));
    expect(output).toContain('Restart the application');
    expect(output).toContain('does not execute a chat or tool action');
  });

  it.each(['rerun-local-setup', 'repair-local-artifacts'])('preserves explicit Managed mode when repairing %s', (remediation) => {
    const output = formatDoctorReport(report([
      { name: 'build', status: 'fail', code: 'E-SETUP-008', remediation },
    ], 'managed'));
    expect(output).toContain('glirastes setup --managed');
    expect(output).toContain('glirastes doctor --managed --verbose');
    expect(output).toContain('glirastes doctor --managed --json');
    expect(output).not.toMatch(/glirastes (setup|doctor)(?! --managed)\b/);
  });

  it('discloses technical codes on request, without mutating the machine report', () => {
    const value = report([
      { name: 'principal', status: 'fail', code: 'E-SCOPE-003', remediation: 'declare-server-principal' },
    ]);
    const before = JSON.stringify(value);
    expect(formatDoctorReport(value, { verbose: true })).toContain('E-SCOPE-003');
    expect(JSON.stringify(value)).toBe(before);
  });

  it('never interpolates unrecognized diagnostic text even in verbose output', () => {
    const value = report([
      { name: 'private-content', status: 'fail', code: 'E-private-content', remediation: 'private-content' },
    ]);
    expect(formatDoctorReport(value, { verbose: true })).not.toContain('private-content');
    expect(formatDoctorReport(value)).toContain('glirastes doctor --json');
  });
});
