import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './index.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

function captureStdout(): () => string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('glirastes help and version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([[['--help']], [['-h']], [['help']], [[]]])('prints the usage for %j', async (args) => {
    const stdout = captureStdout();
    await runCli(args);
    expect(stdout()).toMatch(/^Usage: glirastes init /);
    expect(stdout()).toContain('glirastes connect --base-url <url>');
    expect(process.exitCode).toBeUndefined();
  });

  it.each([[['--version']], [['-v']]])('prints the package version for %j', async (args) => {
    const stdout = captureStdout();
    await runCli(args);
    expect(stdout()).toBe(manifest.version);
  });

  it('rejects an unknown command with a bounded diagnostic that points at --help', async () => {
    await expect(runCli(['deploy'])).rejects.toMatchObject({
      name: 'FoundationDiagnosticError',
      code: 'E-SETUP-030',
      message: "Unknown command 'deploy'.",
      remediation: 'Run glirastes --help to list the commands.',
    });
  });
});
