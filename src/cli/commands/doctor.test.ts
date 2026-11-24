import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverFoundationExecutions } from '../../codegen/index.js';
import { runCli } from '../index.js';
import { applySetupPlan } from './apply-setup-plan.js';
import { createDoctorReport, formatDoctorReport } from './doctor.js';
import { createSetupPlan } from './setup-plan.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de50${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixture(principal = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-doctor-'));
  const inventory = {
    schemaVersion: 2 as const,
    targetAppKey: 'fixture',
    executions: [],
  };
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  await writeJson(root, 'package.json', {
    name: 'fixture',
    dependencies: { next: '16.0.0', 'better-auth': '1.0.0' },
    glirastes: principal ? { principal: 'server-verified' } : {},
  });
  await writeJson(root, '.glirastes/foundation-execution-inventory.json', inventory);
  await writeJson(root, '.glirastes/prompt-bundle.json', {
    schemaVersion: 1,
    appId: id('1'),
    artifactRef: 'local://fixture/prompts',
    sections: {
      planner: 'Plan safely.',
      appBehavior: 'Use the fixture.',
      responseStyle: 'Be concise.',
      capabilityFragments: {},
    },
  });
  await writeJson(root, '.glirastes/setup-artifact.json', {
    schemaVersion: 1,
    artifactId: id('2'),
    runId: id('3'),
    appId: id('1'),
    discoveryDigest: discovery.inventoryDigest,
    assessmentMode: 'interview',
    status: 'ready',
    tools: [],
    planner: {
      plannerId: id('4'),
      modelBindingRef: 'model-standard',
      promptBindingRef: 'prompt-v1',
      budgetProfileRef: 'interactive-default',
      toolIds: [],
    },
    prompts: {
      bundleDigest: digest('A'),
      artifactRef: 'registry://fixture/prompts/v1',
      plannerDigest: digest('B'),
      appBehaviorDigest: digest('C'),
      responseStyleDigest: digest('D'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-08-14T10:00:00.000Z',
  });
  const plan = await createSetupPlan({ rootDir: root });
  await applySetupPlan({ rootDir: root, plan });
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('createDoctorReport', () => {
  it('keeps the actionable missing-setup diagnosis for a fresh app without changing it', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-fresh-doctor-'));
    const source = JSON.stringify({ name: 'fresh-app', dependencies: { next: '16.0.0' } });
    await writeFile(join(rootDir, 'package.json'), source);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const report = await createDoctorReport({ rootDir, env: {} });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual({
      name: 'project', status: 'fail', code: 'E-SETUP-005',
      remediation: 'create-required-setup-artifact',
    });
    expect(formatDoctorReport(report)).toContain('Ask your coding agent');
    expect(await readFile(join(rootDir, 'package.json'), 'utf8')).toBe(source);
    await expect(readFile(join(rootDir, '.glirastes/setup-artifact.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers optional diagnostic details through the real CLI', async () => {
    const rootDir = await fixture(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCli(['doctor', '--root', rootDir]);
      expect(String(log.mock.calls[0]?.[0])).not.toContain('E-SCOPE-003');
      log.mockClear();
      await runCli(['doctor', '--root', rootDir, '--verbose']);
      expect(String(log.mock.calls[0]?.[0])).toContain('E-SCOPE-003');
      expect(String(log.mock.calls[0]?.[0])).toContain('server-side');
    } finally {
      log.mockRestore();
    }
  });

  it('validates a Connected descriptor, ignored secret, scope, and credential offline', async () => {
    const rootDir = await fixture();
    const appId = id('1');
    const environmentId = id('9');
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId,
      runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), [
      'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
      'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
      '',
    ].join('\n'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const report = await createDoctorReport({
      rootDir,
      env: {},
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('pass');
    expect(report.mode).toBe('connected');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'connection-descriptor', status: 'pass' }),
      expect.objectContaining({ name: 'connection-secret-path', status: 'pass' }),
      expect.objectContaining({ name: 'connection-scope', status: 'pass' }),
      expect.objectContaining({ name: 'connection-credential', status: 'pass' }),
    ]));
    expect(report.counts.warnings).toBe(0);
    expect(JSON.stringify(report)).not.toContain('gl_abcdefghijklmnopqrstuvwxyz123456');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['/nonexistent/glirastes-tmp', '/dev'])('reads the secret file with TMPDIR=%s: reads never stage', async (temporary) => {
    const rootDir = await fixture();
    vi.stubEnv('TMPDIR', temporary);
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1, baseUrl: 'https://control.example', appId: id('1'), runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), 'GLIRASTES_CONTROL_PLANE_URL=https://control.example\nGLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456\n');

    const report = await createDoctorReport({ rootDir, env: {}, isGitIgnored: vi.fn().mockResolvedValue(true) });

    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'connection-secret-path', status: 'pass' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'connection-credential', status: 'pass' }));
  });

  it('warns when the descriptor is environment-bound, not when it has no environmentId', async () => {
    const appId = id('1');
    const run = async (extra: Record<string, string>) => {
      const rootDir = await fixture();
      await writeJson(rootDir, '.glirastes/platform-connection.json', {
        schemaVersion: 1,
        baseUrl: 'https://control.example',
        appId,
        ...extra,
        runnerKey: 'fixture-runner',
      });
      await writeFile(join(rootDir, '.env.local'), [
        'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
        'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
        '',
      ].join('\n'));
      return createDoctorReport({
        rootDir,
        env: {},
        isGitIgnored: vi.fn().mockResolvedValue(true),
      });
    };

    const appBound = await run({});
    expect(appBound.status).toBe('pass');
    expect(appBound.counts.warnings).toBe(0);

    const envBound = await run({ environmentId: id('9') });
    expect(envBound.status).toBe('pass');
    expect(envBound.checks).toContainEqual(expect.objectContaining({
      name: 'connection-environment-bound',
      status: 'warn',
      remediation: 'reconnect-for-app-key',
    }));
    expect(formatDoctorReport(envBound))
      .toContain('run `glirastes connect` again to use one key for all environments');
  });

  it('hints that the old app, environment and runner variables are no longer needed', async () => {
    const rootDir = await fixture();
    const appId = id('1');
    const environmentId = id('9');
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId,
      runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), [
      'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
      `GLIRASTES_APP_ID=${appId}`,
      `GLIRASTES_ENVIRONMENT_ID=${environmentId}`,
      'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
      '',
    ].join('\n'));

    const report = await createDoctorReport({
      rootDir,
      env: { GLIRASTES_RUNNER_KEY: 'fixture-runner' },
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('pass');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'connection-obsolete-variables',
      status: 'warn',
      remediation: 'remove-obsolete-connection-variables',
    }));
    const text = formatDoctorReport(report);
    expect(text).toMatch(/no longer needed/);
    expect(text).toContain('GLIRASTES_APP_ID');
    expect(text).not.toContain(appId);
    expect(text).not.toContain('fixture-runner');
  });

  it('fails a standalone app that still carries a runtime key', async () => {
    const rootDir = await fixture();

    const report = await createDoctorReport({
      rootDir,
      env: { GLIRASTES_API_KEY: 'gl_processprocessprocessprocess1234' },
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'runtime-mode', status: 'fail', code: 'E-SETUP-009',
    }));
    expect(JSON.stringify(report)).not.toContain('gl_processprocessprocessprocess1234');
  });

  it('keeps a standalone app valid with only a control plane URL', async () => {
    const rootDir = await fixture();

    const report = await createDoctorReport({
      rootDir,
      env: { GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101' },
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'runtime-mode', status: 'pass',
    }));
  });

  it('fails Connected Doctor scope checks before any network access', async () => {
    const rootDir = await fixture();
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId: id('1'),
      environmentId: id('9'),
      runnerKey: 'fixture-runner',
    });
    await writeFile(join(rootDir, '.env.local'), [
      'GLIRASTES_CONTROL_PLANE_URL=https://other.example',
      'GLIRASTES_API_KEY=gl_abcdefghijklmnopqrstuvwxyz123456',
      '',
    ].join('\n'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const report = await createDoctorReport({
      rootDir,
      env: {},
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'connection-scope', status: 'fail', code: 'E-SCOPE-004',
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still requires the verified local secret file with complete process credentials', async () => {
    const rootDir = await fixture();
    const environmentId = id('9');
    await writeJson(rootDir, '.glirastes/platform-connection.json', {
      schemaVersion: 1,
      baseUrl: 'https://control.example',
      appId: id('1'),
      environmentId,
      runnerKey: 'fixture-runner',
    });

    const report = await createDoctorReport({
      rootDir,
      env: {
        GLIRASTES_CONTROL_PLANE_URL: 'https://control.example',
        GLIRASTES_API_KEY: 'gl_processprocessprocessprocess1234',
      },
      isGitIgnored: vi.fn().mockResolvedValue(true),
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'connection-secret-path', status: 'fail',
    }));
    expect(JSON.stringify(report)).not.toContain(
      'gl_processprocessprocessprocess1234',
    );
  });
  it('passes a current local setup with bounded deterministic checks', async () => {
    const rootDir = await fixture();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const before = await readFile(join(rootDir, '.glirastes/setup-artifact.json'), 'utf8');

    const first = await createDoctorReport({ rootDir });
    const second = await createDoctorReport({ rootDir });

    expect(second).toEqual(first);
    expect(first.status).toBe('pass');
    expect(first).toMatchObject({
      schemaVersion: 1,
      mode: 'standalone',
      counts: { tools: 0, passed: expect.any(Number), warnings: 0, failed: 0 },
    });
    expect(first.checks.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'project', 'framework', 'auth-provider', 'principal', 'artifacts',
      'build', 'receipt', 'runtime-mode',
    ]));
    expect(formatDoctorReport(first)).toMatch(/restart the application/i);
    expect(JSON.stringify(first)).not.toMatch(/prompt|secret|credential|source/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(rootDir, '.glirastes/setup-artifact.json'), 'utf8'))
      .toBe(before);
  });

  it.each([
    ['an own guard with a declared principal', { '@nestjs/core': '11.0.0' }, true, 'pass', 'E-SCOPE-100'],
    ['Passport without a declared principal', { '@nestjs/core': '11.0.0', '@nestjs/passport': '11.0.0' }, false, 'pass', 'E-SCOPE-100'],
    ['no known package and no declaration', { '@nestjs/core': '11.0.0' }, false, 'warn', 'E-SCOPE-101'],
  ] as const)('sign-in integration: %s', async (_label, dependencies, principal, status, code) => {
    const rootDir = await fixture(principal);
    const path = join(rootDir, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...manifest, dependencies }));

    const report = await createDoctorReport({ rootDir });

    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'auth-provider', status, code }));
  });

  it('fails when server-verified principal wiring is not declared', async () => {
    const rootDir = await fixture(false);

    const report = await createDoctorReport({ rootDir });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'principal',
      status: 'fail',
      code: 'E-SCOPE-003',
    }));
  });

  it('fails when built artifacts no longer match the local inputs', async () => {
    const rootDir = await fixture();
    await writeFile(
      join(rootDir, '.glirastes/build/runtime-manifest.json'),
      '{"stale":true}\n',
      'utf8',
    );

    const report = await createDoctorReport({ rootDir });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'build', status: 'fail', code: 'E-SETUP-008',
    }));
  });

  it('fails explicit Managed checks without reading or printing values', async () => {
    const rootDir = await fixture();
    vi.stubEnv('GLIRASTES_CONTROL_PLANE_URL', '');
    vi.stubEnv('GLIRASTES_API_KEY', '');

    const report = await createDoctorReport({ rootDir, managed: true });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'runtime-mode', status: 'fail', code: 'E-SETUP-009',
    }));
    expect(JSON.stringify(report)).not.toContain('GLIRASTES_API_KEY');
  });

  it('prints one JSON report and sets a non-zero exit code on failure', async () => {
    const rootDir = await fixture(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['doctor', '--root', rootDir, '--json']);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).status).toBe('fail');
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });

  describe('voice input worklet', () => {
    const CHAT = "import { AiChatProvider } from 'glirastes/react';\n"
      + 'export function Chat() { return <AiChatProvider transport={t} voice={{ enabled: true }} />; }\n';

    it('adds no check for an app without voice input', async () => {
      const rootDir = await fixture();
      const report = await createDoctorReport({ rootDir });
      expect(report.checks.map(({ name }) => name)).not.toContain('voice-worklet');
    });

    it('fails with the concrete fix when voice is used and the worklet is not provided', async () => {
      const rootDir = await fixture();
      await mkdir(join(rootDir, 'src/components'), { recursive: true });
      await writeFile(join(rootDir, 'src/components/chat.tsx'), CHAT);

      const report = await createDoctorReport({ rootDir });

      expect(report.status).toBe('fail');
      expect(report.checks).toContainEqual({
        name: 'voice-worklet', status: 'fail', code: 'E-SETUP-034', remediation: 'provide-audio-worklet',
      });
      const text = formatDoctorReport(report);
      expect(text).toContain('✗ Voice input audio worklet');
      expect(text).toContain('glirastes stt worklet');
      expect(text).toContain('"predev": "glirastes stt worklet && <existing predev>"');
      expect(text).not.toContain('next dev"');
      expect(text).toContain('Next.js, Vite and Create React App');
      expect(formatDoctorReport(report, { verbose: true })).toContain('Voice input audio worklet (E-SETUP-034)');
    });

    const useVoice = async (rootDir: string, options = '') => {
      await mkdir(join(rootDir, 'src'), { recursive: true });
      await writeFile(join(rootDir, 'src/voice.ts'),
        `import { RecordedSttAdapter } from 'glirastes/react';\nexport const stt = new RecordedSttAdapter(${options});\n`);
    };
    const serve = async (rootDir: string, path = 'audio-worklet-processor.js') => {
      await mkdir(join(rootDir, 'public', path, '..'), { recursive: true });
      await writeFile(join(rootDir, 'public', path), "registerProcessor('audio-processor', class {});\n");
    };
    const scripts = async (rootDir: string, value: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const path = join(rootDir, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...manifest, ...extra, scripts: value }));
    };
    const voiceCheck = async (rootDir: string) => (await createDoctorReport({ rootDir })).checks
      .find(({ name }) => name === 'voice-worklet');

    it('passes when the file is served at the default URL', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir);
      await serve(rootDir);
      expect(await voiceCheck(rootDir)).toEqual({ name: 'voice-worklet', status: 'pass', code: 'E-SETUP-108', remediation: 'none' });
    });

    it('only warns when a copy step exists but the file is not there yet (next dev started directly)', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir);
      await scripts(rootDir, { predev: 'glirastes stt worklet && glirastes tools refresh --keep-going' });
      const report = await createDoctorReport({ rootDir });
      expect(report.checks).toContainEqual({
        name: 'voice-worklet', status: 'warn', code: 'E-SETUP-108', remediation: 'run-audio-worklet-copy',
      });
      const text = formatDoctorReport(report);
      expect(text).toContain('! Voice input audio worklet');
      expect(text).toContain('pnpm');
      await serve(rootDir);
      expect((await voiceCheck(rootDir))?.status).toBe('pass');
    });

    it('reads the copy step from the scripts only, not from the rest of the manifest', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir);
      await scripts(rootDir, {}, { description: 'serves audio-worklet-processor.js via glirastes stt worklet' });
      expect((await voiceCheck(rootDir))?.status).toBe('fail');
    });

    it('treats a copy step with another --out folder as unverifiable', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir);
      await scripts(rootDir, { prebuild: 'glirastes stt worklet --out static' });
      expect(await voiceCheck(rootDir)).toEqual({
        name: 'voice-worklet', status: 'warn', code: 'E-SETUP-108', remediation: 'verify-audio-worklet-url',
      });
    });

    it('fails and names both paths when the configured workletUrl is not where the copy step writes', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir, "{ workletUrl: '/custom/worklet.js' }");
      await scripts(rootDir, { predev: 'glirastes stt worklet && glirastes tools refresh --keep-going' });
      const report = await createDoctorReport({ rootDir });
      expect(report.checks).toContainEqual({
        name: 'voice-worklet', status: 'fail', code: 'E-SETUP-034', remediation: 'align-audio-worklet-url',
        detail: { workletUrl: '/custom/worklet.js', copyTarget: 'public/audio-worklet-processor.js' },
      });
      expect(report.status).toBe('fail');
      const text = formatDoctorReport(report);
      expect(text).toContain('✗ Voice input audio worklet');
      expect(text).toContain('/custom/worklet.js');
      expect(text).toContain('public/audio-worklet-processor.js');
      // Served at the configured path, the check passes whatever the copy step writes.
      await serve(rootDir, 'custom/worklet.js');
      expect((await voiceCheck(rootDir))?.status).toBe('pass');
    });

    it('only warns when the configured path is the one a copy step with --out under public/ creates', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir, "{ workletUrl: '/custom/audio-worklet-processor.js' }");
      await scripts(rootDir, { prebuild: 'glirastes stt worklet --out public/custom && next build' });
      expect(await voiceCheck(rootDir)).toEqual({
        name: 'voice-worklet', status: 'warn', code: 'E-SETUP-108', remediation: 'run-audio-worklet-copy',
      });
      await scripts(rootDir, { prebuild: 'glirastes stt worklet --out public/other' });
      expect(await voiceCheck(rootDir)).toMatchObject({
        status: 'fail', remediation: 'align-audio-worklet-url',
        detail: { workletUrl: '/custom/audio-worklet-processor.js', copyTarget: 'public/other/audio-worklet-processor.js' },
      });
      // Outside public/ the served URL is unknown, so the same file name stays a warning.
      await scripts(rootDir, { prebuild: 'glirastes stt worklet --out static' });
      expect((await voiceCheck(rootDir))?.remediation).toBe('verify-audio-worklet-url');
    });

    it('fails for a file name no glirastes copy step can create, wherever it copies', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir, "{ workletUrl: '/custom/worklet.js' }");
      await scripts(rootDir, { prebuild: 'glirastes stt worklet --out static' });
      expect(await voiceCheck(rootDir)).toMatchObject({
        status: 'fail', remediation: 'align-audio-worklet-url',
        detail: { workletUrl: '/custom/worklet.js', copyTarget: 'static/audio-worklet-processor.js' },
      });
    });

    it('only warns for a configured URL under a base path ending in the copied file (Next basePath, Vite base)', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir, "{ workletUrl: '/app/audio-worklet-processor.js' }");
      await scripts(rootDir, { predev: 'glirastes stt worklet' });
      expect(await voiceCheck(rootDir)).toEqual({
        name: 'voice-worklet', status: 'warn', code: 'E-SETUP-108', remediation: 'verify-audio-worklet-url',
      });
    });

    it('ignores workletUrl literals in test files', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir);
      await mkdir(join(rootDir, 'src/__tests__'), { recursive: true });
      for (const path of ['src/voice.test.ts', 'src/voice.spec.tsx', 'src/__tests__/voice.ts']) {
        await writeFile(join(rootDir, path),
          "import { RecordedSttAdapter } from 'glirastes/react';\nnew RecordedSttAdapter({ workletUrl: '/custom/worklet.js' });\n");
      }
      await scripts(rootDir, { predev: 'glirastes stt worklet' });
      expect((await voiceCheck(rootDir))?.remediation).toBe('run-audio-worklet-copy');
    });

    it('checks a configured worklet path, not the default file, and only warns about an absolute URL', async () => {
      const rootDir = await fixture();
      await useVoice(rootDir, "{ workletUrl: '/static/pcm.js?v=2' }");
      await serve(rootDir);
      expect((await voiceCheck(rootDir))?.status).toBe('fail');
      await serve(rootDir, 'static/pcm.js');
      expect((await voiceCheck(rootDir))?.status).toBe('pass');
      await useVoice(rootDir, "{ workletUrl: 'https://cdn.example.test/pcm.js' }");
      expect(await voiceCheck(rootDir)).toEqual({
        name: 'voice-worklet', status: 'warn', code: 'E-SETUP-108', remediation: 'verify-audio-worklet-url',
      });
    });

    it('reports the check in the JSON output of the CLI', async () => {
      const rootDir = await fixture();
      await mkdir(join(rootDir, 'src'), { recursive: true });
      await writeFile(join(rootDir, 'src/chat.tsx'), CHAT);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runCli(['doctor', '--root', rootDir, '--json']);
        const report = JSON.parse(String(log.mock.calls[0]?.[0])) as { checks: Array<{ name: string; status: string }> };
        expect(report.checks).toContainEqual(expect.objectContaining({ name: 'voice-worklet', status: 'fail' }));
      } finally {
        log.mockRestore();
        process.exitCode = 0;
      }
    });
  });

  // #26: without react-markdown every chat answer shows its raw Markdown source.
  describe('react-markdown for the React chat', () => {
    const install = async (rootDir: string, name: string) => {
      await writeJson(rootDir, `node_modules/${name}/package.json`, { name, version: '1.0.0' });
    };
    const useChat = async (rootDir: string, specifier = 'glirastes/react') => {
      await mkdir(join(rootDir, 'src'), { recursive: true });
      await writeFile(join(rootDir, 'src/chat.tsx'),
        `import { AiChat } from '${specifier}';\nexport function Chat() { return <AiChat />; }\n`);
    };
    const markdownCheck = async (rootDir: string) => (await createDoctorReport({ rootDir })).checks
      .find(({ name }) => name === 'react-markdown');

    it('warns when the app imports glirastes/react and react-markdown is not resolvable', async () => {
      const rootDir = await fixture();
      await useChat(rootDir);
      await install(rootDir, 'glirastes');

      const report = await createDoctorReport({ rootDir });

      expect(report.checks).toContainEqual({
        name: 'react-markdown', status: 'warn', code: 'E-SETUP-109', remediation: 'install-react-markdown',
      });
      const text = formatDoctorReport(report);
      expect(text).toContain('React chat Markdown rendering');
      expect(text).toContain('react-markdown');
      expect(text).not.toMatch(/\b(?:npm|yarn|pnpm|bun) (?:install|add)\b/);
    });

    it('warns for glirastes/embed as well', async () => {
      const rootDir = await fixture();
      await useChat(rootDir, 'glirastes/embed');
      await install(rootDir, 'glirastes');
      expect((await markdownCheck(rootDir))?.status).toBe('warn');
    });

    it('passes when react-markdown is resolvable, also hoisted to a parent folder', async () => {
      const rootDir = await fixture();
      await useChat(rootDir);
      await install(rootDir, 'glirastes');
      await install(rootDir, 'react-markdown');
      expect(await markdownCheck(rootDir)).toEqual({ name: 'react-markdown', status: 'pass', code: 'E-SETUP-109', remediation: 'none' });

      const workspace = await mkdtemp(join(tmpdir(), 'glirastes-doctor-workspace-'));
      const app = join(workspace, 'apps', 'web');
      await mkdir(app, { recursive: true });
      const fixtureRoot = await fixture();
      await useChat(fixtureRoot);
      await install(workspace, 'glirastes');
      await install(workspace, 'react-markdown');
      // The app folder sits under the workspace whose node_modules hold both packages.
      await mkdir(join(workspace, 'apps'), { recursive: true });
      const { cp } = await import('node:fs/promises');
      await cp(fixtureRoot, app, { recursive: true });
      expect((await markdownCheck(app))?.status).toBe('pass');
    });

    it('adds no check for an app without the React chat, nor before dependencies are installed', async () => {
      const server = await fixture();
      await install(server, 'glirastes');
      expect(await markdownCheck(server)).toBeUndefined();

      const fresh = await fixture();
      await useChat(fresh);
      expect(await markdownCheck(fresh)).toBeUndefined();
    });
  });

  describe('apps without Next.js', () => {
    const key = 'gl_abcdefghijklmnopqrstuvwxyz123456';

    async function backend(): Promise<string> {
      const rootDir = await fixture();
      await writeJson(rootDir, 'package.json', {
        name: 'fixture',
        dependencies: { '@nestjs/core': '11.0.0', 'better-auth': '1.0.0' },
        glirastes: { principal: 'server-verified' },
      });
      await writeJson(rootDir, '.glirastes/platform-connection.json', {
        schemaVersion: 1,
        baseUrl: 'https://control.example',
        appId: id('1'),
        runnerKey: 'fixture-runner',
      });
      return rootDir;
    }

    const connectionChecks = (report: Awaited<ReturnType<typeof createDoctorReport>>) => report.checks
      .filter(({ name }) => name.startsWith('connection-'))
      .map(({ name, status, remediation }) => ({ name, status, remediation }));

    it('checks the process environment only, without a secret file check', async () => {
      const rootDir = await backend();
      await writeFile(join(rootDir, '.env.local'), 'GLIRASTES_APP_ID=old\n');
      const isGitIgnored = vi.fn();

      const report = await createDoctorReport({
        rootDir,
        env: { GLIRASTES_CONTROL_PLANE_URL: 'https://control.example', GLIRASTES_API_KEY: key },
        isGitIgnored,
      });

      expect(connectionChecks(report)).toEqual([
        { name: 'connection-descriptor', status: 'pass', remediation: 'none' },
        { name: 'connection-credential', status: 'pass', remediation: 'none' },
        { name: 'connection-scope', status: 'pass', remediation: 'none' },
      ]);
      expect(report.checks).toContainEqual(expect.objectContaining({ name: 'runtime-mode', status: 'pass' }));
      expect(isGitIgnored).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain(key);
    });

    it('asks for GLIRASTES_API_KEY or --dotenv when the key is missing', async () => {
      const rootDir = await backend();

      const report = await createDoctorReport({ rootDir, env: {}, isGitIgnored: vi.fn() });

      expect(connectionChecks(report)).toContainEqual({
        name: 'connection-credential', status: 'fail', remediation: 'provide-connection-api-key',
      });
      expect(report.checks.map(({ name }) => name)).not.toContain('connection-secret-path');
      expect(formatDoctorReport(report)).toContain('or pass --dotenv <path>');
    });

    it('checks --dotenv and its obsolete variables', async () => {
      const rootDir = await backend();
      await mkdir(join(rootDir, 'apps/backend'), { recursive: true });
      await writeFile(join(rootDir, 'apps/backend/.env'), [
        'GLIRASTES_CONTROL_PLANE_URL=https://control.example',
        `GLIRASTES_API_KEY=${key}`,
        'GLIRASTES_RUNNER_KEY=old',
        '',
      ].join('\n'));
      const isGitIgnored = vi.fn().mockResolvedValue(true);

      const report = await createDoctorReport({ rootDir, env: {}, envFile: 'apps/backend/.env', isGitIgnored });

      expect(connectionChecks(report)).toEqual([
        { name: 'connection-descriptor', status: 'pass', remediation: 'none' },
        { name: 'connection-secret-path', status: 'pass', remediation: 'none' },
        { name: 'connection-credential', status: 'pass', remediation: 'none' },
        { name: 'connection-scope', status: 'pass', remediation: 'none' },
        { name: 'connection-obsolete-variables', status: 'warn', remediation: 'remove-obsolete-connection-variables' },
      ]);
      expect(isGitIgnored).toHaveBeenCalledWith(join(rootDir, 'apps/backend/.env'), rootDir);
      expect(JSON.stringify(report)).not.toContain(key);
    });

    it('takes --dotenv=<path> from the CLI and refuses a repeated flag', async () => {
      const rootDir = await backend();
      await writeFile(join(rootDir, 'backend.env'), `GLIRASTES_CONTROL_PLANE_URL=https://control.example\nGLIRASTES_API_KEY=${key}\n`);
      vi.stubEnv('GLIRASTES_API_KEY', '');
      vi.stubEnv('GLIRASTES_CONTROL_PLANE_URL', '');
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await runCli(['doctor', `--root=${rootDir}`, '--dotenv=backend.env', '--json']);

      // The temporary project is outside any Git repository: nothing can be committed.
      const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Awaited<ReturnType<typeof createDoctorReport>>;
      expect(connectionChecks(report)).toContainEqual({ name: 'connection-secret-path', status: 'pass', remediation: 'none' });
      expect(connectionChecks(report)).toContainEqual({ name: 'connection-credential', status: 'pass', remediation: 'none' });
      await expect(runCli(['doctor', '--root', rootDir, '--dotenv', 'a.env', '--dotenv=b.env']))
        .rejects.toMatchObject({ code: 'E-SETUP-032' });
      log.mockRestore();
    });

    it('points an invalid tools.json at tools.json, not at the secret file', async () => {
      const rootDir = await backend();
      await writeFile(join(rootDir, '.glirastes/tools.json'), '{"schemaVersion":1}');

      const report = await createDoctorReport({ rootDir, env: {}, isGitIgnored: vi.fn() });

      const secretPath = report.checks.find(({ name }) => name === 'connection-secret-path');
      expect(secretPath).toMatchObject({ status: 'fail', code: 'E-TOOLS-002', remediation: 'repair-tools-config' });
    });

    it('fails a --dotenv file that Git does not ignore', async () => {
      const rootDir = await backend();
      await writeFile(join(rootDir, '.env'), `GLIRASTES_CONTROL_PLANE_URL=https://control.example\nGLIRASTES_API_KEY=${key}\n`);

      const report = await createDoctorReport({
        rootDir, env: {}, envFile: '.env', isGitIgnored: vi.fn().mockResolvedValue(false),
      });

      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'connection-secret-path', status: 'fail', code: 'E-CONNECT-SECRET-TRACKED',
      }));
    });
  });
});
