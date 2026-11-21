import { SttLocalError } from './errors.js';

export interface SttPlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Present on glibc-based Linux; missing on musl (Alpine) and on non-Linux systems. */
  glibcVersionRuntime?: string;
}

const PREFIX = 'glirastes/server/stt-local';

function atLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return a > major || (a === major && b >= minor);
}

/**
 * Refuses platforms the sherpa-onnx-node binaries cannot load on and warns on
 * untested ones. Supported: darwin-arm64, linux-x64 with glibc ≥ 2.32,
 * linux-arm64 with glibc ≥ 2.17.
 */
export function checkSttPlatform(info: SttPlatformInfo): { warning?: string } {
  if (info.platform === 'linux') {
    if (!info.glibcVersionRuntime) {
      throw new SttLocalError(
        'platform_unsupported',
        `${PREFIX} needs glibc; musl-based Linux (Alpine) is not supported. Use a Debian or Ubuntu based image such as node:22-bookworm-slim.`,
      );
    }
    if (info.arch === 'x64') {
      if (!atLeast(info.glibcVersionRuntime, 2, 32)) {
        throw new SttLocalError(
          'platform_unsupported',
          `${PREFIX} needs glibc 2.32 or newer on linux-x64 (found ${info.glibcVersionRuntime}).`,
        );
      }
      return {};
    }
    if (info.arch === 'arm64' && atLeast(info.glibcVersionRuntime, 2, 17)) return {};
  }
  if (info.platform === 'darwin' && info.arch === 'arm64') return {};
  return { warning: `${info.platform}-${info.arch} is not tested with ${PREFIX}.` };
}

/** The running process's platform, arch and glibc runtime version. */
export function currentSttPlatform(): SttPlatformInfo {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  return {
    platform: process.platform,
    arch: process.arch,
    ...(glibcVersionRuntime ? { glibcVersionRuntime } : {}),
  };
}
