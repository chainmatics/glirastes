import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './index.js';

describe('glirastes install', () => {
  it('asks for setup-skill consent and the hosts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-install-'));
    const answers = ['yes', 'codex'];
    const ask = vi.fn().mockImplementation(async () => answers.shift());
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      await runCli([
        'install',
        '--root',
        root,
        '--dry-run',
      ], { ask });
    } finally {
      console.log = originalLog;
    }

    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]?.[0]).toContain('setup skills');
    expect(ask.mock.calls[1]?.[0]).toContain('codex, claude, gemini');
    expect(output.join('\n')).toContain('setting-up-glirastes');
    expect(output.join('\n')).toContain('.agents/skills');
  });

  it('supports explicit non-interactive consent flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-install-'));
    const ask = vi.fn();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runCli([
        'install',
        '--root',
        root,
        '--with-setup-skills',
        '--host',
        'gemini',
        '--dry-run',
      ], { ask });
    } finally {
      console.log = originalLog;
    }

    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects an unsupported host before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-install-'));

    await expect(runCli([
      'install',
      '--root',
      root,
      '--with-setup-skills',
      '--host',
      'other',
      '--dry-run',
    ])).rejects.toThrow('codex, claude, or gemini');
  });

  describe('without a terminal', () => {
    const withoutTty = async (run: () => Promise<void>) => {
      const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      try {
        await run();
      } finally {
        if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete (process.stdin as { isTTY?: boolean }).isTTY;
        if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout); else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    };

    it('fails with E-SETUP-035 naming the flags to pass', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-install-'));
      await withoutTty(async () => {
        await expect(runCli(['install', '--root', root, '--dry-run'])).rejects.toMatchObject({
          code: 'E-SETUP-035',
          message: expect.stringMatching(/--with-setup-skills or --without-setup-skills.*--force/),
        });
        await expect(runCli(['install', '--root', root, '--dry-run', '--with-setup-skills'])).rejects.toMatchObject({
          code: 'E-SETUP-035',
          message: expect.stringContaining('--host <codex|claude|gemini>'),
        });
      });
    });

    it('succeeds when the flags answer every question', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-install-'));
      const originalLog = console.log;
      console.log = () => {};
      try {
        await withoutTty(async () => {
          await runCli(['install', '--root', root, '--dry-run', '--host', 'claude', '--with-setup-skills', '--force']);
          await runCli(['install', '--root', root, '--dry-run', '--without-setup-skills']);
        });
      } finally {
        console.log = originalLog;
      }
    });
  });
});
