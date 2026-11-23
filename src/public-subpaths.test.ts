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
    ['framework-neutral UI bridge', './browser', './dist/browser/index.js'],
    ['node:http bridge', './server/node', './dist/server/node/index.js'],
    ['local STT', './server/stt-local', './dist/server/stt-local/index.js'],
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

  it('exports the voice input audio worklet file', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(packageJson.exports['./react/audio-worklet-processor.js'])
      .toBe('./dist/react/audio-worklet-processor.js');
    // The worklet is loaded by the browser as a module of its own: no imports.
    const source = await readFile(new URL('./react/audio-worklet-processor.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import\s/m);
    expect(source).toContain("registerProcessor('audio-processor'");
  });

  it('exports the chat styles unlayered and, selectable, inside @layer glirastes', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown>; scripts: Record<string, string> };
    expect(packageJson.exports['./react/styles.css']).toBe('./dist/react/styles.css');
    expect(packageJson.exports['./react/styles.layered.css']).toBe('./dist/react/styles.layered.css');
    // Written after the plain copy, from the same source.
    const build = packageJson.scripts.build;
    expect(build.indexOf('node scripts/generate-layered-styles.mjs')).toBeGreaterThan(build.indexOf('cp src/react/styles.css dist/react/styles.css'));
  });

  it('ships local STT ESM only with an exactly pinned optional peer', async () => {
    const [packageJson, cjsConfig, serverSource, shims] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8').then((text) => JSON.parse(text) as {
        exports: Record<string, { import?: unknown; require?: unknown }>;
        peerDependencies: Record<string, string>;
        peerDependenciesMeta: Record<string, { optional?: boolean }>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
        files: string[];
      }),
      readFile(new URL('../tsconfig.cjs.json', import.meta.url), 'utf8').then((text) => JSON.parse(text) as { exclude: string[] }),
      readFile(new URL('./server/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/generate-subpath-shims.mjs', import.meta.url), 'utf8'),
    ]);
    expect(packageJson.exports['./server/stt-local']).toEqual({
      import: { types: './dist/server/stt-local/index.d.ts', default: './dist/server/stt-local/index.js' },
    });
    expect(packageJson.exports['./server/stt-local']!.require).toBeUndefined();
    expect(packageJson.peerDependencies['sherpa-onnx-node']).toBe('2.0.1');
    expect(packageJson.peerDependenciesMeta['sherpa-onnx-node']!.optional).toBe(true);
    expect(packageJson.devDependencies?.['sherpa-onnx-node']).toBeUndefined();
    expect(packageJson.dependencies?.['sherpa-onnx-node']).toBeUndefined();
    expect(packageJson.files).toContain('docs/local-stt.md');
    expect(cjsConfig.exclude).toContain('src/server/stt-local/**');
    expect(serverSource).not.toContain('stt-local');
    expect(shims).toContain("['server/stt-local', 'server/stt-local', { esmOnly: true }]");
  });

  it('keeps glirastes/server/node free of Platform and engine imports', async () => {
    const { readdir } = await import('node:fs/promises');
    const dir = new URL('./server/node/', import.meta.url);
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toContain('index.ts');
    for (const name of files) {
      const source = await readFile(new URL(name, dir), 'utf8');
      expect(source, name).not.toMatch(/from ['"]\.\.\/\.\.\/(?:sync|runtime-service)\//);
      expect(source, name).not.toMatch(/lancer/);
      expect(source, name).not.toMatch(/from ['"]ai['"]/);
      expect(source, name).not.toMatch(/console\./);
    }
  });

  it('keeps glirastes/server/node on Node built-ins and its own files at runtime', async () => {
    const { readdir } = await import('node:fs/promises');
    const dir = new URL('./server/node/', import.meta.url);
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const runtimeImports = (source: string) => [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms)]
      .map((match) => match[1]!);
    for (const name of files) {
      const source = await readFile(new URL(name, dir), 'utf8');
      for (const specifier of runtimeImports(source)) {
        expect(
          specifier.startsWith('node:') || /^\.\/[\w-]+\.js$/.test(specifier) || specifier === '../body-limit.js',
          `${name} imports ${specifier}`,
        ).toBe(true);
      }
    }
    // The shared limit is a leaf: it imports nothing.
    const leaf = await readFile(new URL('./server/body-limit.ts', import.meta.url), 'utf8');
    expect(leaf).not.toMatch(/^import\s/m);
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
    // Upgrade notes ship; the api-surface snapshot is a repo-only CI input.
    expect(packageJson.files).toContain('upgrade-notes');
    expect(packageJson.files).toContain('!upgrade-notes/api-surface.released.json');
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
      './cli/commands/tools/resolve.ts',
      './cli/commands/tools/describe.ts',
      './cli/commands/tools/eval.ts',
      './cli/commands/tools/policy.ts',
      './cli/commands/tools/verify.ts',
      './cli/commands/tools/watch.ts',
      './codegen/tools/pipeline.ts',
      './codegen/tools/worklist.ts',
      './codegen/tools/routing-eval.ts',
      './codegen/tools/semantics.ts',
      './codegen/tools/agentic.ts',
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

  it('builds into an emptied dist/, so compiled files of removed sources are neither packed nor checked', async () => {
    const parsed = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string> };
    const build = parsed.scripts?.build ?? '';
    const clear = build.indexOf("rmSync('dist', { recursive: true, force: true })");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(build.indexOf('tsc -p tsconfig.json'));
  });

  it('ships glirastes/browser framework-neutral, with its legacy shim', async () => {
    const [packageJson, shims, ...sources] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/generate-subpath-shims.mjs', import.meta.url), 'utf8'),
      ...['index', 'ui-action-bus', 'navigation', 'client-actions', 'query-filters'].map((name) => (
        readFile(new URL(`./browser/${name}.ts`, import.meta.url), 'utf8')
      )),
    ]);
    expect((JSON.parse(packageJson) as { files?: string[] }).files).toContain('browser');
    expect(shims).toContain("['browser', 'browser']");
    for (const source of sources) {
      expect(source).not.toMatch(/from ['"](?:react|react-dom|next|vue)(?:\/|['"])/);
      expect(source).not.toMatch(/from ['"]\.\.\//);
    }
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
