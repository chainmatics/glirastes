import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  killProcessGroupQuietly,
  processGroupAlive,
  stopProcessGroup,
} from './browser/process-group.mjs';

/**
 * The browser and reference-app suites stop their detached dev servers with
 * these helpers. They run under `node --test` with a real browser and are not
 * part of the Vitest gate, so the cleanup rules are pinned here instead.
 */
const UNREAL_PID = 2 ** 30; // above every Linux/macOS pid_max: real kill() can only answer ESRCH
const killError = (code: string) => Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' });
type Sent = Array<number | string>;

describe('process group cleanup', () => {
  it('treats a zombie-only process group (EPERM on macOS) as stopped', async () => {
    const sent: Sent = [];
    const zombieGroup = (pid: number, signal: number | string) => { sent.push(pid, signal); throw killError('EPERM'); };
    await stopProcessGroup({ pid: UNREAL_PID }, 30, zombieGroup);
    expect(sent).toEqual([-UNREAL_PID, 0]);
  });

  it('stops waiting once the group becomes zombies after SIGTERM', async () => {
    const sent: Sent = [];
    let terminated = false;
    const exitsOnTerm = (_pid: number, signal: number | string) => {
      sent.push(signal);
      if (signal === 'SIGTERM') { terminated = true; return true; }
      if (terminated) throw killError('EPERM');
      return true;
    };
    await stopProcessGroup({ pid: UNREAL_PID }, 1_000, exitsOnTerm);
    expect(sent.slice(0, 2)).toEqual([0, 'SIGTERM']);
    expect(sent).not.toContain('SIGKILL');
  });

  it('treats EPERM on the signal itself as a group that is already gone', async () => {
    const sent: Sent = [];
    let zombies = false;
    // Alive at the probe, zombies by the time SIGTERM is sent.
    const turnsZombieOnSignal = (_pid: number, signal: number | string) => {
      sent.push(signal);
      if (signal === 0) { if (zombies) throw killError('EPERM'); return true; }
      zombies = true;
      throw killError('EPERM');
    };
    await stopProcessGroup({ pid: UNREAL_PID }, 1_000, turnsZombieOnSignal);
    expect(sent.slice(0, 3)).toEqual([0, 'SIGTERM', 0]);
    expect(sent).not.toContain('SIGKILL');
  });

  it('treats EPERM on SIGKILL as a group that is already gone', async () => {
    const sent: Sent = [];
    let killed = false;
    // Ignores SIGTERM; becomes zombies when SIGKILL is sent.
    const zombieOnKill = (_pid: number, signal: number | string) => {
      sent.push(signal);
      if (signal === 'SIGKILL') { killed = true; throw killError('EPERM'); }
      if (signal === 0 && killed) throw killError('EPERM');
      return true;
    };
    await stopProcessGroup({ pid: UNREAL_PID }, 30, zombieOnKill);
    expect(sent).toContain('SIGTERM');
    expect(sent.at(-1)).toBe(0);
    expect(sent.filter((signal) => signal === 'SIGKILL')).toHaveLength(1);
  });

  it('still surfaces unexpected kill errors on the probe and on the signal', async () => {
    const broken = () => { throw killError('EINVAL'); };
    await expect(stopProcessGroup({ pid: UNREAL_PID }, 30, broken)).rejects.toMatchObject({ code: 'EINVAL' });
    const brokenSignal = (_pid: number, signal: number | string) => {
      if (signal === 0) return true;
      throw killError('EINVAL');
    };
    await expect(stopProcessGroup({ pid: UNREAL_PID }, 30, brokenSignal)).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('kills quietly when the group is already gone', () => {
    expect(() => killProcessGroupQuietly(UNREAL_PID)).not.toThrow();
    expect(processGroupAlive(UNREAL_PID)).toBe(false);
  });

  it('escalates when its own child ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    try {
      await once(child.stdout, 'data');
      await stopProcessGroup(child, 30);
      // A zombie-only group counts as stopped before Node has reaped the leader.
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      killProcessGroupQuietly(child.pid!);
    }
  }, 10_000);

  it('also stops descendants after the group leader exits', async () => {
    const descendant = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    try {
      await once(child.stdout, 'data');
      await stopProcessGroup(child, 30);
      expect(processGroupAlive(child.pid!)).toBe(false);
    } finally {
      killProcessGroupQuietly(child.pid!);
    }
  }, 10_000);
});

describe('browser test hygiene', () => {
  it('lets a failing reference import fail with its own error', () => {
    const tests = resolve(dirname(fileURLToPath(import.meta.url)));
    const swallowed = readdirSync(tests)
      .filter((name) => name.endsWith('.test.mjs'))
      .filter((name) => /import\([^)]*\)\s*\.catch\(/.test(readFileSync(join(tests, name), 'utf8')));
    expect(swallowed).toEqual([]);
  });
});
