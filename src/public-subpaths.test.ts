import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageExport {
  default?: string;
  import?: { default?: string };
}

describe('public foundation subpaths', () => {
  it.each([
    ['STT', './stt', './dist/stt/index.js'],
    ['AI SDK engine', './ai-sdk', './dist/runtime/ai-sdk/index.js'],
    [
      'Next.js adapter',
      './adapter/nextjs',
      './dist/server/adapters/nextjs/index.js',
    ],
    [
      'NestJS adapter',
      './adapter/nestjs',
      './dist/server/adapters/nestjs/index.js',
    ],
  ])('exports the independently importable %s surface', async (
    _label,
    subpath,
    expectedDefault,
  ) => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, PackageExport>;
    };

    const configured = packageJson.exports?.[subpath];
    expect(configured).toBeDefined();
    expect(configured?.default ?? configured?.import?.default)
      .toBe(expectedDefault);
  });

  it('keeps the standalone STT surface framework-neutral', async () => {
    const source = await readFile(
      new URL('./stt/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('use-stt');
    expect(source).not.toMatch(/from ['"]react/);
  });
});
