import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Pack install: the real tarball, installed into an empty consumer that has
 * only what `package.json` declares (dependencies and peers), must load every
 * subpath as ESM and as CommonJS, run its CLI and type-check for a strict
 * NodeNext consumer. Pack completeness proves every relative import is packed;
 * this proves the package needs nothing it does not declare.
 *
 * Needs a built `dist/` (`bun run build`). Dependencies are linked from this
 * checkout's node_modules: Node resolves a link to its real path, so their own
 * dependencies resolve there while glirastes itself only sees the consumer.
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

interface Manifest {
  version: string;
  bin: Record<string, string>;
  exports: Record<string, string | { import?: unknown; require?: unknown; types?: string }>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

let manifest: Manifest;
let workDir: string;
let consumer: string;

const specifier = (subpath: string) => (subpath === '.' ? 'glirastes' : `glirastes/${subpath.slice(2)}`);
const codeSubpaths = () => Object.keys(manifest.exports).filter((subpath) => !subpath.endsWith('.css'));
const requireSubpaths = () => codeSubpaths().filter((subpath) => {
  const target = manifest.exports[subpath];
  return typeof target === 'object' && target.require !== undefined;
});

/** Loads each specifier in a fresh Node process and returns the ones that failed, with the first error line. */
async function loadAll(kind: 'import' | 'require', specifiers: string[]): Promise<string[]> {
  // The React and embed entries import their stylesheet the way bundlers expect;
  // the ESM probe stubs `.css` like a bundler would, and nothing else.
  const stubCss = 'export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }';
  const report = 'catch (e) { console.log(s + ": " + String(e?.message ?? e).split("\\n")[0]); }';
  const probe = kind === 'import'
    ? `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(stubCss)}`)}); for (const s of JSON.parse(process.argv[1])) { try { await import(s); } ${report} }`
    : `const r = require('node:module').createRequire(process.cwd() + '/'); for (const s of JSON.parse(process.argv[1])) { try { r(s); } ${report} }`;
  const { stdout } = await run(
    process.execPath,
    [...(kind === 'import' ? ['--input-type=module'] : ['--input-type=commonjs']), '-e', probe, JSON.stringify(specifiers)],
    { cwd: consumer, env: { ...process.env, NODE_PATH: '' }, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

beforeAll(async () => {
  if (!existsSync(join(SDK_ROOT, 'dist/cli/bin.js'))) {
    throw new Error('Run bun run build first: dist/cli/bin.js is missing.');
  }
  manifest = JSON.parse(await readFile(join(SDK_ROOT, 'package.json'), 'utf8')) as Manifest;
  workDir = await mkdtemp(join(tmpdir(), 'glirastes-pack-install-'));
  await run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', workDir], {
    cwd: SDK_ROOT, env: process.env, maxBuffer: 16 * 1024 * 1024,
  });
  const tarball = (await readdir(workDir)).find((name) => name.endsWith('.tgz'));
  expect(tarball, 'packed tarball').toBe(`glirastes-${manifest.version}.tgz`);

  consumer = join(workDir, 'consumer');
  const installed = join(consumer, 'node_modules', 'glirastes');
  await mkdir(installed, { recursive: true });
  await run('tar', ['-xzf', join(workDir, tarball!), '-C', installed, '--strip-components=1']);
  await writeFile(join(consumer, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n');
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    const source = join(SDK_ROOT, 'node_modules', name);
    if (!existsSync(source)) continue;
    const target = join(consumer, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(realpathSync(source), target, 'dir');
  }
}, 120_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('package pack install', () => {
  it('installs only what package.json declares', async () => {
    const links = await readdir(join(consumer, 'node_modules'));
    expect(links).toContain('glirastes');
    expect(links).toContain('zod');
    expect(links).not.toContain('vite');
    expect(existsSync(join(consumer, 'node_modules/glirastes/src'))).toBe(false);
  });

  it('imports every subpath as ESM from the installed tarball', async () => {
    expect(codeSubpaths().length).toBeGreaterThanOrEqual(15);
    expect(await loadAll('import', codeSubpaths().map(specifier))).toEqual([]);
  }, 60_000);

  it('requires every CommonJS subpath from the installed tarball', async () => {
    expect(requireSubpaths().length).toBeGreaterThanOrEqual(10);
    expect(await loadAll('require', requireSubpaths().map(specifier))).toEqual([]);
  }, 60_000);

  it('ships the stylesheet subpath', () => {
    expect(existsSync(join(consumer, 'node_modules/glirastes', String(manifest.exports['./react/styles.css'])))).toBe(true);
  });

  it('runs the installed CLI', async () => {
    const bin = join(consumer, 'node_modules/glirastes', manifest.bin.glirastes!);
    const version = await run(process.execPath, [bin, '--version'], { cwd: consumer });
    expect(version.stdout.trim()).toBe(manifest.version);
    const help = await run(process.execPath, [bin, '--help'], { cwd: consumer });
    expect(help.stdout).toMatch(/^Usage: glirastes init /);
  }, 30_000);

  it('type-checks for a strict NodeNext consumer (ESM and CommonJS)', async () => {
    const typed = codeSubpaths();
    await writeFile(
      join(consumer, 'index.ts'),
      `${typed.map((subpath, index) => `import * as m${index} from '${specifier(subpath)}';`).join('\n')}\nexport const loaded = [${typed.map((_, index) => `m${index}`).join(', ')}];\n`,
    );
    await writeFile(
      join(consumer, 'index.cts'),
      `${requireSubpaths().map((subpath, index) => `import r${index} = require('${specifier(subpath)}');`).join('\n')}\nexport const loaded = [${requireSubpaths().map((_, index) => `r${index}`).join(', ')}];\n`,
    );
    await writeFile(join(consumer, 'tsconfig.json'), `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        noEmit: true, skipLibCheck: true, types: [], jsx: 'react-jsx',
      },
      files: ['index.ts', 'index.cts'],
    }, null, 2)}\n`);
    const tsc = join(SDK_ROOT, 'node_modules/typescript/bin/tsc');
    await expect(run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: consumer })).resolves.toMatchObject({ stdout: '' });
  }, 120_000);
});
