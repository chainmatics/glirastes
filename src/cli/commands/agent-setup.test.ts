import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../index.js';
import { launchSetupAgent } from './agent-setup.js';

const roots: string[] = [];
async function freshApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-init-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '16', react: '19' } }));
  return root;
}
const available = async () => [{ host: 'codex' as const, executable: '/usr/local/bin/codex' }];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('agent-led init', () => {
  it('previews fresh setup without files, provider keys or an agent process', async () => {
    const root = await freshApp();
    const launch = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['init', '--root', root, '--agent', 'codex', '--dry-run', '--json'], {
      init: { env: {}, isInteractive: false, available, launch },
    });
    const preview = JSON.parse(String(log.mock.calls[0][0]));
    expect(preview).toMatchObject({ schemaVersion: 1, status: 'preview', agent: 'codex' });
    expect(preview.instructions).toContain('successful authorized tool action');
    expect(preview.instructions).toContain('setting-up-glirastes');
    expect(preview.instructions).not.toContain('OPENROUTER_API_KEY=');
    expect(launch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('continues inside the current coding agent without nesting another process', async () => {
    const root = await freshApp();
    const launch = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['init', '--root', root, '--json'], {
      init: { env: { CODEX_THREAD_ID: 'private-session' }, isInteractive: false, available, launch },
    });
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(log).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ agent: 'codex', status: 'continue-in-session' });
    expect(JSON.stringify(result)).not.toContain('private-session');
    expect(result.instructions).toContain('server-side');
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.agents/skills/setting-up-glirastes/SKILL.md'), 'utf8')).toContain('Setting Up Glirastes');
    expect(await readdir(root)).not.toContain('.env');
    expect(result.scaffold).toMatchObject({
      written: ['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json'],
    });
    const config = JSON.parse(await readFile(join(root, '.glirastes/tools.json'), 'utf8')) as { appId: string };
    expect(config.appId).toBe(result.scaffold.appId);
    expect(result.instructions).toContain('Never change the appId in tools.json.');
  });

  it('requires an unambiguous host before writing anything in a noninteractive shell', async () => {
    const root = await freshApp();
    await expect(runCli(['init', '--root', root], { init: {
      env: {}, isInteractive: false,
      available: async () => [...await available(), { host: 'claude', executable: '/usr/local/bin/claude' }],
    } })).rejects.toMatchObject({ remediation: 'choose-setup-agent' });
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('rejects JSON before starting an interactive agent or writing skills', async () => {
    const root = await freshApp();
    const launch = vi.fn().mockResolvedValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['init', '--root', root, '--agent', 'codex', '--json'], {
      init: { env: {}, isInteractive: true, available, launch },
    })).rejects.toMatchObject({ remediation: 'use-interactive-output' });
    expect(launch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('never prompts into JSON output when two hosts need a choice', async () => {
    const root = await freshApp();
    const ask = vi.fn().mockResolvedValue('codex');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['init', '--root', root, '--dry-run', '--json'], { init: {
      env: {}, isInteractive: true, ask,
      available: async () => [...await available(), { host: 'claude', executable: '/usr/local/bin/claude' }],
    } })).rejects.toMatchObject({ remediation: 'choose-setup-agent' });
    expect(ask).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('does not nest another provider inside an existing coding-agent session', async () => {
    const root = await freshApp();
    const launch = vi.fn().mockResolvedValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['init', '--root', root, '--agent', 'claude'], { init: {
      env: { CODEX_THREAD_ID: 'current' }, isInteractive: true, launch,
      available: async () => [...await available(), { host: 'claude', executable: '/usr/local/bin/claude' }],
    } })).rejects.toMatchObject({ remediation: 'use-current-agent-session' });
    expect(launch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('does not install skills without an interactive terminal or current agent', async () => {
    const root = await freshApp();
    await expect(runCli(['init', '--root', root], { init: {
      env: {}, isInteractive: false, available,
    } })).rejects.toMatchObject({ remediation: 'use-interactive-agent' });
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('reports interrupted agent work without claiming a verified setup', async () => {
    const root = await freshApp();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['init', '--root', root], { init: {
      env: {}, isInteractive: true, available, launch: async () => 130,
    } })).rejects.toMatchObject({ remediation: 'resume-selected-agent' });
    expect(await readFile(join(root, '.agents/skills/setting-up-glirastes/SKILL.md'), 'utf8')).toContain('Setting Up Glirastes');
    expect(log.mock.calls.flat().join('\n')).not.toContain('Local app setup');
  });

  it('runs a real child with exact arguments and cwd without shell interpretation', async () => {
    const root = await freshApp();
    const script = join(root, 'child.mjs');
    const argument = '$(touch shell-was-used) ; literal argument';
    await writeFile(script, `import { writeFileSync } from 'node:fs';
      writeFileSync('child-result.json', JSON.stringify({ cwd: process.cwd(), argument: process.argv[2], marker: process.env.SETUP_TEST_MARKER }));
      process.exitCode = 7;`);
    expect(await launchSetupAgent({
      executable: process.execPath, args: [script, argument], cwd: root,
      env: { SETUP_TEST_MARKER: 'child-only' },
    })).toBe(7);
    const result = JSON.parse(await readFile(join(root, 'child-result.json'), 'utf8'));
    expect(result).toMatchObject({ argument, marker: 'child-only' });
    expect(await readdir(root)).not.toContain('shell-was-used');
  });

  it('does not silently choose another provider when the requested CLI is missing', async () => {
    const root = await freshApp();
    await expect(runCli(['init', '--root', root, '--agent', 'claude'], {
      init: { env: {}, isInteractive: true, available },
    })).rejects.toMatchObject({ remediation: 'install-selected-agent' });
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('starts the exact CLI without bypass flags and verifies real artifacts after it exits', async () => {
    const root = await freshApp();
    const launch = vi.fn().mockResolvedValue(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['init', '--root', root, '--agent', 'codex', '--managed'], {
      init: { env: {}, isInteractive: true, available, launch },
    });
    expect(launch).toHaveBeenCalledTimes(1);
    const request = launch.mock.calls[0][0];
    expect(request).toMatchObject({ executable: '/usr/local/bin/codex' });
    expect(request.args).toHaveLength(1);
    expect(request.args[0]).toContain('--managed');
    expect(request.args[0]).not.toMatch(/--dangerously|--full-auto|--ask-for-approval never/);
    expect(request.env.GLIRASTES_SETUP_AGENT_ACTIVE).toBe('1');
    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('Local app setup');
    expect(log.mock.calls.flat().join('\n')).not.toContain('Setup complete');
  });

  it('preserves a modified installed skill and directs the agent to the bundled reference', async () => {
    const root = await freshApp();
    const path = join(root, '.agents/skills/setting-up-glirastes/SKILL.md');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'User-owned setup guidance.');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['init', '--root', root, '--json'], {
      init: { env: { CODEX_THREAD_ID: 'current' }, isInteractive: false, available },
    });
    expect(await readFile(path, 'utf8')).toBe('User-owned setup guidance.');
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(result.instructions).toContain('Preserve modified installed skills');
    expect(result.instructions).not.toContain(`${root}/.agents/skills/setting-up-glirastes`);
  });

  it('rejects linked skill container directories before installation', async () => {
    const root = await freshApp();
    const outside = await freshApp();
    await symlink(outside, join(root, '.agents'));
    await expect(runCli(['init', '--root', root], { init: {
      env: { CODEX_THREAD_ID: 'current' }, isInteractive: false, available,
    } })).rejects.toMatchObject({ remediation: 'review-setup-write-paths' });
    expect(await readdir(outside)).toEqual(['package.json']);
  });

  it('prevents recursive bootstrap and preserves existing files', async () => {
    const root = await freshApp();
    await expect(runCli(['init', '--root', root], { init: {
      env: { GLIRASTES_SETUP_AGENT_ACTIVE: '1' }, available,
    } })).rejects.toMatchObject({ remediation: 'continue-current-setup' });
    expect(await readdir(root)).toEqual(['package.json']);
  });
});
