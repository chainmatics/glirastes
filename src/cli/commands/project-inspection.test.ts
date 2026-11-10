import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
async function fixture(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-intake-'));
  roots.push(root);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

async function inspect(root: string) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runCli(['setup', 'inspect', '--root', root, '--json']);
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0][0]));
  } finally {
    log.mockRestore();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.open).mockReset();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('artifact-free setup inspection', () => {
  it('recognizes a fresh Next.js app but never certifies auth or integration', async () => {
    const root = await fixture({
      'package.json': { dependencies: { next: '16', react: '19', '@clerk/nextjs': '6' }, glirastes: { principal: 'server-verified' } },
    });
    const report = await inspect(root);
    expect(report).toMatchObject({
      schemaVersion: 1, scope: 'local-only', status: 'needs-integration-verification',
      components: [{ directory: '.', runtimes: ['node'], frontend: ['nextjs', 'react'], backend: ['nextjs'], auth: ['clerk'] }],
      findings: [],
    });
    expect(report.components[0].evidence).toContainEqual({ file: 'package.json', marker: 'next' });
    expect(JSON.stringify(report)).not.toContain('server-verified');
    expect(await readdir(root)).toEqual(['package.json']);
  });

  it('keeps a React frontend and NestJS backend as separate components', async () => {
    const root = await fixture({
      'package.json': { private: true, workspaces: ['apps/*'] },
      'apps/web/package.json': { dependencies: { react: '19', vite: '7' } },
      'apps/api/package.json': { dependencies: { '@nestjs/core': '11', '@azure/msal-node': '5' } },
    });
    const report = await inspect(root);
    expect(report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: 'apps/web', frontend: ['react'], backend: [] }),
      expect.objectContaining({ directory: 'apps/api', frontend: [], backend: ['nestjs'], auth: ['entra'] }),
    ]));
    expect(report.components).toHaveLength(3);
    expect(report).not.toHaveProperty('bindings');
  });

  it('recognizes Vue and a Python backend without a Node backend assumption', async () => {
    const root = await fixture({
      'frontend/package.json': { dependencies: { vue: '3' } },
      'backend/requirements.txt': '# django is not installed\nfastapi[standard]>=0.100\nuvicorn==0.30\n',
      'backend/pyproject.toml': '[project]\nname = "private-project"\n',
    });
    const report = await inspect(root);
    expect(report.components).toHaveLength(2);
    expect(report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: 'frontend', frontend: ['vue'], backend: [], runtimes: ['node'] }),
      expect.objectContaining({ directory: 'backend', frontend: [], backend: ['fastapi'], runtimes: ['python'] }),
    ]));
  });

  it('returns no source, script, dependency URL or environment values and makes no request', async () => {
    const root = await fixture({
      'package.json': { name: 'private-name', dependencies: { react: 'https://private-credential@host/react.tgz', 'private-library': '1' }, scripts: { preinstall: 'echo private-script' } },
      '.env': 'SECRET=private-env',
      'src/index.ts': 'throw new Error("private-source");',
      'requirements.txt': '--index-url https://private-credential@host\n-r private-requirements.txt\n',
    });
    const before = await readFile(join(root, 'package.json'), 'utf8');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const serialized = JSON.stringify(await inspect(root));
    expect(serialized).not.toContain('private-');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
    expect(await readdir(root)).not.toContain('.glirastes');
  });

  it('does not follow linked manifests or linked app directories', async () => {
    const outside = await fixture({ 'package.json': { dependencies: { next: '16' } } });
    const root = await fixture({});
    await symlink(join(outside, 'package.json'), join(root, 'package.json'));
    await symlink(outside, join(root, 'linked-app'));
    const report = await inspect(root);
    expect(report.components).toEqual([]);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'linked-path-skipped' }),
    ]));
  });

  it('does not mistake malformed manifests for valid detected projects', async () => {
    const root = await fixture({ 'package.json': '{ "next": private-broken-json' });
    const report = await inspect(root);
    expect(report.components).toEqual([]);
    expect(report.findings).toContainEqual({ code: 'invalid-manifest', file: 'package.json' });
    expect(JSON.stringify(report)).not.toContain('private-broken');
  });

  it('rejects a queued directory replaced by an external link before traversal', async () => {
    const outside = await fixture({ 'package.json': { dependencies: { next: '16' } } });
    const root = await fixture({ 'child/requirements.txt': '', 'package.json': {} });
    const canonicalRoot = await filesystem.realpath(root);
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // Simulate a concurrent checkout change after child is queued, using real files.
    vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
      if (path === join(root, 'package.json') || path === join(canonicalRoot, 'package.json')) {
        await rename(join(root, 'child'), join(root, '.saved-child'));
        await symlink(outside, join(root, 'child'));
      }
      return open(path, flags, mode);
    });
    const report = await inspect(root);
    expect(report.components).toEqual([
      expect.objectContaining({ directory: '.', frontend: [], backend: [] }),
    ]);
    expect(report.findings).toContainEqual({ code: 'linked-path-skipped', file: 'child' });
  });

  it('ignores dependency, generated and hidden project copies', async () => {
    const files: Record<string, object> = {};
    for (const dir of ['node_modules/lib', 'vendor/lib', 'dist', 'build', '.worktrees/app', '.git']) {
      files[`${dir}/package.json`] = { dependencies: { next: '16' } };
    }
    expect((await inspect(await fixture(files))).components).toEqual([]);
  });

  it('reports a bounded inspection instead of reading an oversized manifest', async () => {
    const root = await fixture({ 'package.json': ' '.repeat(262_145) });
    const report = await inspect(root);
    expect(report.components).toEqual([]);
    expect(report.findings).toContainEqual({ code: 'manifest-too-large', file: 'package.json' });
  });

  it('reports depth limits without claiming a complete repository scan', async () => {
    const root = await fixture({ 'a/b/c/d/e/package.json': { dependencies: { next: '16' } } });
    const report = await inspect(root);
    expect(report.components).toEqual([]);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'inspection-depth-limit' }),
    ]));
  });

  it('bounds the number of directories and marks incomplete inspection', async () => {
    const files: Record<string, object> = {};
    for (let index = 0; index < 130; index++) {
      files[`apps-${String(index).padStart(3, '0')}/package.json`] = { dependencies: { react: '19' } };
    }
    const report = await inspect(await fixture(files));
    expect(report.components.length).toBeLessThan(130);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'inspection-directory-limit' }),
    ]));
  });

  it('treats pyproject presence as a Python hint, not parsed framework proof', async () => {
    const report = await inspect(await fixture({
      'pyproject.toml': '# fastapi might be added later\n[project]\nname="fixture"',
    }));
    expect(report.components).toEqual([
      expect.objectContaining({ runtimes: ['python'], backend: [], frontend: [] }),
    ]);
    expect(report.components[0].evidence).toEqual([{ file: 'pyproject.toml', marker: 'python-project-file' }]);
  });

  it('flags indirect Python requirements without reading arbitrary referenced files', async () => {
    const report = await inspect(await fixture({
      'requirements.txt': '-r private-other.txt\n-e private-project\n',
      'private-other.txt': 'fastapi==0.100',
    }));
    expect(report.components[0].backend).toEqual([]);
    expect(report.findings).toContainEqual({ code: 'requirements-indirection', file: 'requirements.txt' });
    expect(JSON.stringify(report)).not.toContain('private-');
  });

  it('rejects invalid dependency structures and redacts parser details', async () => {
    const report = await inspect(await fixture({ 'package.json': { dependencies: 'private-invalid' } }));
    expect(report.components).toEqual([]);
    expect(report.findings).toContainEqual({ code: 'invalid-manifest', file: 'package.json' });
    expect(JSON.stringify(report)).not.toContain('private-invalid');
  });

  it('offers honest human output for an unrecognized project', async () => {
    const root = await fixture({});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['setup', 'inspect', '--root', root]);
    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('No supported manifest markers detected');
    expect(output).toContain('does not prove integration');
    expect(output).toContain('coding agent');
    expect(output).not.toContain('ready');
  });

  it('summarizes incomplete inspection without a noisy technical finding count', async () => {
    const root = await fixture({ 'a/b/c/d/e/package.json': { dependencies: { next: '16' } } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['setup', 'inspect', '--root', root]);
    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('Some paths need review or were skipped');
    expect(output).not.toContain('inspection findings');
    expect(output).toContain('--json');
  });
});
