import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATED_MODULE,
  generatedModulePath,
  loadToolsConfig,
  normalizeSources,
  ToolsConfigSchema,
} from './config.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const minimal = {
  schemaVersion: 1,
  appId: APP_ID,
  targetAppKey: 'fixture',
  locale: 'en-US',
  sources: ['next-app'],
};
const roots: string[] = [];

async function emptyApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-tools-config-'));
  roots.push(root);
  return root;
}

async function appWith(config: unknown): Promise<string> {
  const root = await emptyApp();
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(
    join(root, '.glirastes/tools.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('tools config', () => {
  it('loads a minimal config with empty emit, enrich and ci sections', async () => {
    const config = loadToolsConfig(await appWith(minimal));
    expect(config).toEqual({ ...minimal, emit: {}, enrich: {}, ci: {} });
    expect(normalizeSources(config)).toEqual([{ kind: 'next-app' }]);
    expect(generatedModulePath(config)).toBe(DEFAULT_GENERATED_MODULE);
  });

  it('accepts object sources, a JavaScript module target and ci flags', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: [{ kind: 'next-app', apiDir: 'app/api' }],
      emit: { module: 'src/generated/glirastes/tools.generated.js', mcpCatalog: false },
      enrich: { managed: false, writeContracts: false },
      ci: { strict: true, requireEnrichment: false },
    }));
    expect(normalizeSources(config)).toEqual([{ kind: 'next-app', apiDir: 'app/api' }]);
    expect(generatedModulePath(config)).toBe('src/generated/glirastes/tools.generated.js');
    expect(config.ci.strict).toBe(true);
  });

  it('accepts the next-pages and url-filters sources with their folder options', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: ['next-app', { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] }, 'url-filters'],
    }));
    expect(normalizeSources(config)).toEqual([
      { kind: 'next-app' },
      { kind: 'next-pages', appDir: 'src/app', srcDir: 'src', stripSegments: ['[locale]'] },
      { kind: 'url-filters' },
    ]);
  });

  it.each([
    ['an unknown key', { ...minimal, openrouterApiKey: 'value' }],
    ['a secret-looking value', { ...minimal, enrich: { model: `sk-or-v1-${'a'.repeat(32)}` } }],
    ['a module outside the app', { ...minimal, emit: { module: '../outside/tools.generated.ts' } }],
    ['an absolute module path', { ...minimal, emit: { module: '/tmp/tools.generated.ts' } }],
    ['an unsupported module extension', { ...minimal, emit: { module: 'src/tools.generated.tsx' } }],
    ['an unknown source kind', { ...minimal, sources: ['rails'] }],
    ['an empty source list', { ...minimal, sources: [] }],
    ['a strip segment that is a path', { ...minimal, sources: [{ kind: 'next-pages', stripSegments: ['a/b'] }] }],
    ['a page option on the endpoint source', { ...minimal, sources: [{ kind: 'next-app', stripSegments: [] }] }],
    ['the next-pages source twice', { ...minimal, sources: ['next-pages', { kind: 'next-pages', appDir: 'app' }] }],
    ['the url-filters source twice', { ...minimal, sources: ['url-filters', 'url-filters'] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });

  it('reports a missing config with E-TOOLS-001', async () => {
    const root = await emptyApp();
    expect(() => loadToolsConfig(root)).toThrowError(expect.objectContaining({
      code: 'E-TOOLS-001',
      path: '.glirastes/tools.json',
    }));
  });

  it('reports unreadable JSON and schema violations with E-TOOLS-002', async () => {
    const unreadable = await appWith('{ not json');
    const wrongVersion = await appWith({ ...minimal, schemaVersion: 2 });
    expect(() => loadToolsConfig(unreadable))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-002' }));
    expect(() => loadToolsConfig(wrongVersion))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-002' }));
  });
});
