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
});
