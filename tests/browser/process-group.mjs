import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// macOS answers kill(-pgid) with EPERM instead of ESRCH while every member of
// the group is a zombie awaiting reaping. These groups are always our own
// detached children (same uid, no setuid), so EPERM can only mean "gone".
const GROUP_GONE = new Set(['ESRCH', 'EPERM']);
const systemKill = (pid, signal) => process.kill(pid, signal);

export function processGroupAlive(pid, kill = systemKill) {
  try { kill(-pid, 0); return true; } catch (error) { if (GROUP_GONE.has(error.code)) return false; throw error; }
}

export function killProcessGroupQuietly(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; }
}

/** SIGTERM, a bounded wait, then SIGKILL; resolves only once the whole group is gone. */
export async function stopProcessGroup(child, graceMs = 3_000, kill = systemKill) {
  const alive = () => processGroupAlive(child.pid, kill);
  const signal = (name) => { try { kill(-child.pid, name); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; } };
  const wait = async (ms) => {
    const deadline = Date.now() + ms;
    while (alive() && Date.now() < deadline) await delay(20);
    return !alive();
  };
  if (!alive()) return;
  signal('SIGTERM');
  if (await wait(graceMs)) return;
  signal('SIGKILL');
  assert.ok(await wait(2_000), 'test process group did not stop after SIGKILL');
}
