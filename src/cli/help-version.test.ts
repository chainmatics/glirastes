import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('glirastes <command> --help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([['--help'], ['-h']])('prints init usage and writes nothing for init %s', async (flag) => {
    const dir = mkdtempSync(join(tmpdir(), 'glirastes-help-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"x","scripts":{}}\n');
      const before = readdirSync(dir).sort();
      const stdout = captureStdout();
      const previous = process.cwd();
      process.chdir(dir);
      try {
        await runCli(['init', flag]);
      } finally {
        process.chdir(previous);
      }
      expect(stdout()).toContain('glirastes init [--agent codex|claude]');
      expect(stdout()).not.toContain('glirastes connect');
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"name":"x","scripts":{}}\n');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['scan', 'setup', 'connect', 'sync', 'doctor', 'install', 'validate', 'build', 'tools'])(
    'prints only the %s usage for --help',
    async (command) => {
      const stdout = captureStdout();
      await runCli([command, '--help']);
      expect(stdout()).toContain(`glirastes ${command}`);
      expect(process.exitCode).toBeUndefined();
    },
  );
});
