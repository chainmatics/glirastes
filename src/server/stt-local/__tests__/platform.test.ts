import { describe, expect, it } from 'vitest';
import { SttLocalError } from '../errors.js';
import { checkSttPlatform, currentSttPlatform } from '../platform.js';

function refusal(run: () => unknown): SttLocalError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SttLocalError);
    expect((error as SttLocalError).code).toBe('platform_unsupported');
    return error as SttLocalError;
  }
  throw new Error('expected a refusal');
}

describe('checkSttPlatform', () => {
  it('refuses musl', () => {
    const error = refusal(() => checkSttPlatform({ platform: 'linux', arch: 'arm64' }));
    expect(error.message).toBe('glirastes/server/stt-local needs glibc; musl-based Linux (Alpine) is not supported. Use a Debian or Ubuntu based image such as node:22-bookworm-slim.');
    expect(error.message).toContain('Alpine');
  });

  it('refuses linux-x64 below glibc 2.32', () => {
    const error = refusal(() => checkSttPlatform({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.31' }));
    expect(error.message).toBe('glirastes/server/stt-local needs glibc 2.32 or newer on linux-x64 (found 2.31).');
  });

  it('accepts linux-x64 2.36 and linux-arm64 2.17 and darwin-arm64 without warning', () => {
    expect(checkSttPlatform({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.36' })).toEqual({});
    expect(checkSttPlatform({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.32' })).toEqual({});
    expect(checkSttPlatform({ platform: 'linux', arch: 'arm64', glibcVersionRuntime: '2.17' })).toEqual({});
    expect(checkSttPlatform({ platform: 'darwin', arch: 'arm64' })).toEqual({});
  });

  it('compares glibc versions numerically', () => {
    expect(checkSttPlatform({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.100' })).toEqual({});
    refusal(() => checkSttPlatform({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '1.99' }));
  });

  it('warns but continues on win32-x64 and darwin-x64', () => {
    expect(checkSttPlatform({ platform: 'win32', arch: 'x64' })).toEqual({ warning: 'win32-x64 is not tested with glirastes/server/stt-local.' });
    expect(checkSttPlatform({ platform: 'darwin', arch: 'x64' })).toEqual({ warning: 'darwin-x64 is not tested with glirastes/server/stt-local.' });
  });

  it('reads the current platform from the process report', () => {
    const info = currentSttPlatform();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
  });
});
