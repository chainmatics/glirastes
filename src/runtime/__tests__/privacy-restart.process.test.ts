/**
 * The restart proof of managed privacy: every case runs two separate
 * operating-system processes (privacy-restart.child.ts) on one
 * FileRuntimeStateStore file. Process 1 accepts or refuses a protected
 * policy; process 2 restarts on what process 1 left behind and tries a chat
 * turn and a recording. A negative case must show zero model and zero cloud
 * audio requests. Tool calls only follow a model step; the gate before each
 * tool call is covered by approval-execution-gate.test.ts.
 */
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RestartReport, RestartScenario } from './privacy-restart.child.js';

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL('./privacy-restart.child.ts', import.meta.url));
const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(join(directory, 'state'), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'glirastes-privacy-restart-'));
  directories.push(directory);
  return { directory, statePath: join(directory, 'state', 'runtime-state.json') };
}

/** Starts one runner process and returns its report. */
async function runner(statePath: string, scenario: Omit<RestartScenario, 'statePath' | 'privateKeyPem'>): Promise<RestartReport> {
  const scenarioPath = join(await mkdtemp(join(tmpdir(), 'glirastes-privacy-scenario-')), 'scenario.json');
  directories.push(join(scenarioPath, '..'));
  await writeFile(scenarioPath, JSON.stringify({ ...scenario, statePath, privateKeyPem }));
  const { stdout } = await run('bun', [CHILD, scenarioPath], {
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: 'test', GLIRASTES_APPROVAL_SECRET: 'privacy-restart-test-approval-secret-0000' },
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as RestartReport;
}

const SERVE = { platform: 'serve', managed: true, firstSyncTimeoutMs: 5_000 } as const;
const UNREACHABLE = { platform: 'unreachable', managed: true, firstSyncTimeoutMs: 200 } as const;
const protectedRevision = (revision: number, bindingMatches = true) => ({ revision, profile: 'protected', bindingMatches }) as const;
const offRevision = (revision: number) => ({ revision, profile: 'off' }) as const;

/** No model request, no cloud audio request. */
function expectNoEgress(report: RestartReport) {
  expect(report.chatStatus).toBe(503);
  expect(report.providerRequests).toBe(0);
  expect(report.fallbackModelCalls).toBe(0);
  expect(report.audioStatus).toBe(503);
  expect(report.audioCloudRequests).toBe(0);
}

describe('managed privacy across a process restart (FileRuntimeStateStore)', { timeout: 180_000 }, () => {
  it('process 1 accepts protection; process 2 with lost state, Platform unreachable and a ready() timeout sends nothing', async () => {
    const { statePath } = await workspace();
    const first = await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    expect(first).toMatchObject({ chatStatus: 200, policy: 'platform', capabilityClaimed: true, appliedReported: true, providerSawCanary: false });
    expect(first.providerRequests).toBeGreaterThan(0);
    expect(first.fallbackModelCalls).toBe(0);
    expect(first.audioCloudRequests).toBe(0);

    await rm(statePath);
    const second = await runner(statePath, UNREACHABLE);
    expectNoEgress(second);
    expect(second).toMatchObject({ chatError: 'privacy_policy_unavailable', policy: 'privacy_policy_unavailable' });
  });

  it('an unreadable state file blocks process 2 although the Platform answers, and is never overwritten', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    await writeFile(statePath, '{"cursor": broken');
    const second = await runner(statePath, { ...SERVE, deployment: offRevision(3), firstSyncTimeoutMs: 300 });
    expectNoEgress(second);
    expect(second.chatError).toBe('privacy_policy_unavailable');
    expect(second.errors).toContain('RuntimeStateUnreadable');
    expect(await readFile(statePath, 'utf8')).toBe('{"cursor": broken');
  });

  it('a state that cannot be saved blocks process 2, even for a newer signed off', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    const before = await readFile(statePath, 'utf8');
    await chmod(join(statePath, '..'), 0o500);
    for (const deployment of [offRevision(3), protectedRevision(3)]) {
      const second = await runner(statePath, { ...SERVE, deployment });
      expectNoEgress(second);
      expect(second.chatError).toBe('privacy_policy_unavailable');
      expect(second.appliedReported).toBe(false);
    }
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('an older signed off replayed after the restart is rejected: the accepted protection stays, never unprotected', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    const second = await runner(statePath, { ...SERVE, deployment: offRevision(1) });
    expect(second.privacyStates).toEqual(['downgrade-rejected']);
    expect(second.appliedReported).toBe(false);
    // The turn runs on the persisted protected revision 2.
    expect(second).toMatchObject({ policy: 'platform', fallbackModelCalls: 0, providerSawCanary: false, audioCloudRequests: 0 });
  });

  it('an off older than the latest accepted protection is rejected after a second restart: nothing runs unprotected', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    await runner(statePath, { ...SERVE, deployment: protectedRevision(3) });
    const third = await runner(statePath, { ...SERVE, deployment: offRevision(2) });
    expect(third.privacyStates).toEqual(['downgrade-rejected']);
    expect(third).toMatchObject({ fallbackModelCalls: 0, audioCloudRequests: 0, providerSawCanary: false });
  });

  it('process 1 refuses protection it cannot enforce; process 2 neither runs unprotected on an older off nor while unreachable', async () => {
    const { statePath } = await workspace();
    const first = await runner(statePath, { ...SERVE, deployment: protectedRevision(2, false) });
    expectNoEgress(first);
    expect(first.privacyStates).toContain('refused');
    expect(first.appliedReported).toBe(false);

    expectNoEgress(await runner(statePath, { ...SERVE, deployment: offRevision(1) }));
    expectNoEgress(await runner(statePath, UNREACHABLE));
  });

  it('process 2 applies a valid newer protected revision: only the approved provider, no originals, no cloud audio', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    const second = await runner(statePath, { ...SERVE, deployment: protectedRevision(3) });
    expect(second).toMatchObject({ chatStatus: 200, policy: 'platform', providerSawCanary: false, fallbackModelCalls: 0, audioCloudRequests: 0, appliedReported: true });
    expect(second.providerRequests).toBeGreaterThan(0);
    expect(second.audioStatus).toBe(503);
  });

  it('process 2 started while the Platform is unreachable sends nothing, although its state is intact', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    const before = await readFile(statePath, 'utf8');
    const second = await runner(statePath, UNREACHABLE);
    expectNoEgress(second);
    expect(second.chatError).toBe('privacy_policy_unavailable');
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('process 2 applies a valid newer signed off: the unprotected path runs, as the Platform decided', async () => {
    const { statePath } = await workspace();
    await runner(statePath, { ...SERVE, deployment: protectedRevision(2) });
    const second = await runner(statePath, { ...SERVE, deployment: offRevision(3) });
    expect(second).toMatchObject({ chatStatus: 200, policy: 'off', providerRequests: 0, fallbackModelCalls: 1, audioStatus: 200, audioCloudRequests: 1, appliedReported: true });
  });

  it('a legacy runner claims no privacy capability and never reports a protected revision as applied', async () => {
    const { statePath } = await workspace();
    const legacy = await runner(statePath, { ...SERVE, managed: false, deployment: protectedRevision(2) });
    expect(legacy).toMatchObject({ capabilityClaimed: false, appliedReported: false, providerRequests: 0, fallbackModelCalls: 0, audioCloudRequests: 0 });
    expect(legacy.chatStatus).toBe(503);
  });
});
