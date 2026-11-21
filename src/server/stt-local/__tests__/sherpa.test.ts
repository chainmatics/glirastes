import { afterEach, describe, expect, it, vi } from 'vitest';
import { SttLocalError } from '../errors.js';
import { loadSherpa, resetSherpaForTests, TESTED_SHERPA_VERSION } from '../sherpa.js';
import type { SttPlatformInfo } from '../platform.js';

const darwin: SttPlatformInfo = { platform: 'darwin', arch: 'arm64' };
const fake = { OfflineRecognizer: class {}, Vad: class {} };

async function failure(promise: Promise<unknown>): Promise<SttLocalError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(SttLocalError);
  return error as SttLocalError;
}

describe('loadSherpa', () => {
  afterEach(() => {
    resetSherpaForTests();
  });

  it('pins the tested version', () => {
    expect(TESTED_SHERPA_VERSION).toBe('2.0.1');
  });

  it('returns the CJS default export', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    const onWarning = vi.fn();
    const sherpa = await loadSherpa({ importer, installedVersion: () => '2.0.1', onWarning, platform: darwin });
    expect(sherpa).toBe(fake);
    expect(importer).toHaveBeenCalledWith('sherpa-onnx-node');
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('loads once per process', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    const options = { importer, installedVersion: () => '2.0.1', platform: darwin };
    await Promise.all([loadSherpa(options), loadSherpa(options)]);
    await loadSherpa(options);
    expect(importer).toHaveBeenCalledOnce();
  });

  it('maps ERR_MODULE_NOT_FOUND to peer_missing with the install command', async () => {
    const importer = async () => {
      throw Object.assign(new Error("Cannot find package 'sherpa-onnx-node' imported from /app/x.js"), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const error = await failure(loadSherpa({ importer, installedVersion: () => undefined, platform: darwin }));
    expect(error.code).toBe('peer_missing');
    expect(error.message).toBe('glirastes/server/stt-local needs the optional peer sherpa-onnx-node 2.0.1. Install it: npm install sherpa-onnx-node@2.0.1');
  });

  it('maps a CJS MODULE_NOT_FOUND naming the package to peer_missing', async () => {
    const importer = async () => {
      throw Object.assign(new Error("Cannot find module 'sherpa-onnx-node'\nRequire stack:\n- /app/x.js"), { code: 'MODULE_NOT_FOUND' });
    };
    const error = await failure(loadSherpa({ importer, installedVersion: () => undefined, platform: darwin }));
    expect(error.code).toBe('peer_missing');
    expect(error.message).toBe('glirastes/server/stt-local needs the optional peer sherpa-onnx-node 2.0.1. Install it: npm install sherpa-onnx-node@2.0.1');
  });

  // webpack (Next.js without serverExternalPackages) replaces the variable import() with a stub
  // that throws this, without a require stack, although the package is installed.
  it('adds the bundler hint to a MODULE_NOT_FOUND without a require stack', async () => {
    const importer = async () => {
      throw Object.assign(new Error("Cannot find module 'sherpa-onnx-node'"), { code: 'MODULE_NOT_FOUND' });
    };
    const error = await failure(loadSherpa({ importer, installedVersion: () => undefined, platform: darwin }));
    expect(error.code).toBe('peer_missing');
    expect(error.message).toBe(
      'glirastes/server/stt-local needs the optional peer sherpa-onnx-node 2.0.1. Install it: npm install sherpa-onnx-node@2.0.1. '
      + "If it is installed, a bundler has inlined the import: in Next.js set serverExternalPackages: ['sherpa-onnx-node', 'glirastes']",
    );
  });

  it.each([
    ['dlopen', Object.assign(new Error('dlopen(/x/sherpa-onnx.node, 0x0001): tried: …'), { code: 'ERR_DLOPEN_FAILED' })],
    ['self-register', new Error('Module did not self-register: /app/node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node')],
    ['cxxabi', new Error("/lib/x86_64-linux-gnu/libstdc++.so.6: version `CXXABI_1.3.15' not found")],
    ['glibc', new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.32' not found")],
    ['platform package', Object.assign(
      new Error("Cannot find module 'sherpa-onnx-linux-x64'\nRequire stack:\n- /app/node_modules/sherpa-onnx-node/addon.js"),
      { code: 'MODULE_NOT_FOUND' },
    )],
  ])('maps native load failures to load_failed with the original message, the installed version and the 2.0.1 hint (%s)', async (_name, original) => {
    const importer = async () => { throw original; };
    const error = await failure(loadSherpa({ importer, installedVersion: () => '2.0.2', onWarning: () => {}, platform: darwin }));
    expect(error.code).toBe('load_failed');
    expect(error.message).toBe(`sherpa-onnx-node 2.0.2 failed to load: ${original.message}. glirastes is tested with sherpa-onnx-node 2.0.1: npm install sherpa-onnx-node@2.0.1`);
    expect(error.cause).toBe(original);
  });

  it('names an unknown installed version', async () => {
    const importer = async () => { throw new Error('boom'); };
    const error = await failure(loadSherpa({ importer, installedVersion: () => undefined, onWarning: () => {}, platform: darwin }));
    expect(error.code).toBe('load_failed');
    expect(error.message).toContain('sherpa-onnx-node unknown failed to load: boom');
  });

  it('retries after a failed load', async () => {
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ default: fake });
    const options = { importer, installedVersion: () => '2.0.1', platform: darwin };
    await failure(loadSherpa(options));
    await expect(loadSherpa(options)).resolves.toBe(fake);
  });

  it('warns once for an untested version', async () => {
    const onWarning = vi.fn();
    const options = { importer: async () => ({ default: fake }), installedVersion: () => '2.0.2', onWarning, platform: darwin };
    await expect(loadSherpa(options)).resolves.toBe(fake);
    await loadSherpa(options);
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith('sherpa-onnx-node 2.0.2 is not tested with glirastes (tested: 2.0.1; linux-x64 2.0.2 does not load on Debian bookworm).');
  });

  it('passes the platform warning on and continues', async () => {
    const onWarning = vi.fn();
    await loadSherpa({ importer: async () => ({ default: fake }), installedVersion: () => '2.0.1', onWarning, platform: { platform: 'win32', arch: 'x64' } });
    expect(onWarning).toHaveBeenCalledWith('win32-x64 is not tested with glirastes/server/stt-local.');
  });

  it('checks the platform before importing', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    const error = await failure(loadSherpa({ importer, platform: { platform: 'linux', arch: 'x64' } }));
    expect(error.code).toBe('platform_unsupported');
    expect(importer).not.toHaveBeenCalled();
  });
});
