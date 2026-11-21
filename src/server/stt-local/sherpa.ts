import { createRequire } from 'node:module';
import { SttLocalError } from './errors.js';
import { checkSttPlatform, currentSttPlatform, type SttPlatformInfo } from './platform.js';
import type { SherpaModule } from './sherpa-types.js';

/** The only sherpa-onnx-node version glirastes is tested with (exact optional peer). */
export const TESTED_SHERPA_VERSION = '2.0.1';

/** Held in a variable so tsc and bundlers do not try to resolve the untyped optional peer. */
const SPECIFIER = 'sherpa-onnx-node';

export interface LoadSherpaOptions {
  importer?: (specifier: string) => Promise<unknown>;
  installedVersion?: () => string | undefined;
  onWarning?: (message: string) => void;
  platform?: SttPlatformInfo;
}

let cached: Promise<SherpaModule> | undefined;

/** Internal: clears the per-process cache between tests. Not part of the public barrel. */
export function resetSherpaForTests(): void {
  cached = undefined;
}

/** Reads `sherpa-onnx-node/package.json` next to the installed package. */
export function readInstalledSherpaVersion(): string | undefined {
  try {
    const version = (createRequire(import.meta.url)(`${SPECIFIER}/package.json`) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

function isPeerMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ERR_MODULE_NOT_FOUND') return true;
  return code === 'MODULE_NOT_FOUND' && /['"]sherpa-onnx-node['"]/.test(error.message.split('\n')[0] ?? '');
}

/**
 * Loads the native addon once per process: platform check, dynamic import of
 * the CommonJS default export, untested-version warning. The main thread
 * calls it before the first worker starts, so restarted workers can load the
 * addon on linux-arm64.
 */
export function loadSherpa(options: LoadSherpaOptions = {}): Promise<SherpaModule> {
  cached ??= load(options).catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

async function load(options: LoadSherpaOptions): Promise<SherpaModule> {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const { warning } = checkSttPlatform(options.platform ?? currentSttPlatform());
  if (warning) warn(warning);

  const installedVersion = options.installedVersion ?? readInstalledSherpaVersion;
  let imported: unknown;
  try {
    imported = await (options.importer ?? ((specifier: string) => import(specifier)))(SPECIFIER);
  } catch (error) {
    if (isPeerMissing(error)) {
      throw new SttLocalError(
        'peer_missing',
        `glirastes/server/stt-local needs the optional peer sherpa-onnx-node ${TESTED_SHERPA_VERSION}. Install it: npm install sherpa-onnx-node@${TESTED_SHERPA_VERSION}`,
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SttLocalError(
      'load_failed',
      `sherpa-onnx-node ${installedVersion() ?? 'unknown'} failed to load: ${message}. glirastes is tested with sherpa-onnx-node ${TESTED_SHERPA_VERSION}: npm install sherpa-onnx-node@${TESTED_SHERPA_VERSION}`,
      { cause: error },
    );
  }

  const version = installedVersion();
  if (version !== TESTED_SHERPA_VERSION) {
    warn(`sherpa-onnx-node ${version ?? 'unknown'} is not tested with glirastes (tested: ${TESTED_SHERPA_VERSION}; linux-x64 2.0.2 does not load on Debian bookworm).`);
  }
  const sherpa = (imported as { default?: unknown }).default ?? imported;
  return sherpa as SherpaModule;
}
