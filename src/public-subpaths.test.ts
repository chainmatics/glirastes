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
    ['framework-neutral chat embed', './embed', './dist/embed/index.js'],
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

  it('packages accepted skills without exposing deferred adapters', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, PackageExport>;
      files?: string[];
    };

    for (const subpath of [
      './server/nestjs',
      './adapter/nestjs',
      './react/langgraph',
      './openapi',
    ]) {
      expect(packageJson.exports?.[subpath]).toBeUndefined();
    }
    expect(packageJson.files).not.toContain('openapi');
    expect(packageJson.files).toContain('skills');
  });

  it('keeps deferred generator APIs out of the Foundation codegen surface', async () => {
    const [source, rootSource, serverSource] = await Promise.all([
      readFile(new URL('./codegen/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
      readFile(new URL('./server/index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).not.toContain('generateAgentSkills');
    expect(source).not.toContain('generateMcpServer');
    expect(source).not.toContain('recommendOutputFormat');
    expect(source).not.toContain('syncAssetToGlirastes');
    expect(source).not.toContain('scanNestControllers');
    expect(source).not.toContain('generateEndpointRegistry');
    expect(source).not.toContain('generateUiRegistry');
    expect(source).not.toContain('generateModuleRegistry');
    expect(source).not.toContain('validateAiTools');
    expect(source).not.toContain('checkAiCoverage');
    expect(source).not.toContain('scaffoldAiTool');
    expect(rootSource).not.toContain('skill-generator');
    expect(rootSource).not.toContain('mcp-generator');
    expect(serverSource).not.toContain("from './lancer/");
    expect(serverSource).not.toContain('createAegisDetector');
  });

  it('keeps the Foundation CLI focused on local setup and connection', async () => {
    const source = await readFile(
      new URL('./cli/index.ts', import.meta.url),
      'utf8',
    );

    // Deferred surfaces stay out. `doctor`, `validate` and `build` are accepted
    // Foundation commands and are asserted positively below.
    for (const command of [
      'generate',
      'generate-skills',
      'generate-mcp-server',
      'generate-auto',
      'install-skills',
      'check-upgrade',
      'generate-endpoint-tools',
      'generate-ui-tools',
      'generate-modules',
      'test',
    ]) {
      expect(source).not.toContain(`'${command}'`);
    }
    for (const command of [
      'scan', 'setup', 'connect', 'doctor', 'install', 'validate', 'build', 'tools',
    ]) {
      expect(source).toContain(`| '${command}'`);
    }

    // `setup guided` preserves the old interview wizard while bare setup
    // applies the detected local plan.
    const wizardSource = await readFile(
      new URL('./cli/commands/setup-wizard.ts', import.meta.url),
      'utf8',
    );
    expect(wizardSource).toContain("return rest[0] === 'guided';");
    expect(source).toContain('if (isWizardInvocation(rest))');

    // Tool generation stays model-free: no provider SDK in the CLI or pipeline.
    for (const file of [
      './cli/commands/tools/index.ts',
      './cli/commands/tools/refresh.ts',
      './cli/commands/tools/check.ts',
      './codegen/tools/pipeline.ts',
    ]) {
      const toolsSource = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(toolsSource).not.toMatch(/@ai-sdk\/openai|openrouter/i);
      expect(toolsSource).not.toContain("'generate'");
    }
  });

  it('ships the embed subpath with its legacy shim and fresh inlined styles', async () => {
    const [packageJson, shims, embedSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/generate-subpath-shims.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./embed/index.ts', import.meta.url), 'utf8'),
    ]);
    const parsed = JSON.parse(packageJson) as { files?: string[]; scripts?: Record<string, string> };
    expect(parsed.files).toContain('embed');
    expect(parsed.scripts?.build).toContain('generate-embed-styles.mjs --check');
    expect(shims).toContain("['embed', 'embed']");
    expect(embedSource).toContain('defineGlirastesChatElement');
    expect(embedSource).not.toMatch(/from ['"]\.\.\/react\/index\.js['"]/);
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
