import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Pack completeness: the tarball must contain every module that shipped code
 * imports. `package.json` `files` carries negated patterns for deferred modules;
 * a pattern that also hides a module a shipped file imports statically makes the
 * published package fail on first import (ERR_MODULE_NOT_FOUND), which no source
 * level test sees because the sources are all present.
 *
 * Needs a built `dist/` like the other suites in this folder (run
 * `bun run build` first; `dist/` is ignored by git). The test never packs to
 * disk: `bun pm pack --dry-run` prints the exact file list the tarball would
 * hold, and the packed files are read from the working tree because pack ships
 * `dist/` unchanged.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(HERE, '..');

type ImportKind = 'import' | 'require';
interface RelativeImport {
  importer: string;
  specifier: string;
  kind: ImportKind;
}

let packed: Set<string>;

beforeAll(async () => {
  if (!existsSync(join(SDK_ROOT, 'dist/cli/bin.js'))) {
    throw new Error('Run bun run build first: dist/cli/bin.js is missing.');
  }
  const { stdout, stderr } = await promisify(execFile)(
    'bun',
    ['pm', 'pack', '--dry-run', '--ignore-scripts'],
    { cwd: SDK_ROOT, env: process.env, maxBuffer: 16 * 1024 * 1024 },
  );
  packed = new Set(
    `${stdout}\n${stderr}`
      .split('\n')
      .map((line) => /^packed\s+\S+\s+(\S.*)$/.exec(line.trim())?.[1])
      .filter((path): path is string => path !== undefined),
  );
}, 60_000);

/** Every relative specifier a JS file imports, re-exports, requires or dynamically imports (comments and strings cannot fool the AST). */
function relativeImports(importer: string, source: string): RelativeImport[] {
  const file = ts.createSourceFile(importer, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  const found: RelativeImport[] = [];
  const add = (node: ts.Node | undefined, kind: ImportKind): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) return;
    if (node.text.startsWith('./') || node.text.startsWith('../')) {
      found.push({ importer, specifier: node.text, kind });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, 'import');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** ESM needs the exact file; CommonJS `require` also probes extensions and directory indexes. */
function isPacked({ importer, specifier, kind }: RelativeImport): boolean {
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = kind === 'require'
    ? [target, `${target}.js`, `${target}.cjs`, `${target}.json`, `${target}/index.js`]
    : [target];
  return candidates.some((candidate) => packed.has(candidate));
}

describe('package pack completeness', () => {
  it('ships every module that packed dist code imports relatively (ESM and dist/cjs)', async () => {
    const scripts = [...packed].filter((path) => path.startsWith('dist/') && /\.(?:js|mjs|cjs)$/.test(path));
    // Guards against a vacuous pass if the dry-run output format ever changes.
    expect(scripts).toContain('dist/cli/bin.js');
    expect(scripts).toContain('dist/cjs/runtime/index.js');

    let checked = 0;
    const missing = new Map<string, string[]>();
    for (const importer of scripts) {
      const source = await readFile(join(SDK_ROOT, importer), 'utf8');
      for (const entry of relativeImports(importer, source)) {
        checked += 1;
        if (isPacked(entry)) continue;
        const target = posix.normalize(posix.join(posix.dirname(importer), entry.specifier));
        missing.set(target, [...(missing.get(target) ?? []), importer]);
      }
    }
    expect(checked).toBeGreaterThan(500);

    const report = [...missing]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, importers]) => `${target} <- ${importers.slice(0, 3).join(', ')}${importers.length > 3 ? ` (+${importers.length - 3})` : ''}`);
    expect(report).toEqual([]);
  }, 60_000);

  it('ships every entry point package.json declares', async () => {
    const manifest = JSON.parse(await readFile(join(SDK_ROOT, 'package.json'), 'utf8')) as {
      main?: string;
      types?: string;
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    const targets = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string') targets.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect([manifest.main, manifest.types, manifest.bin, manifest.exports]);

    const missing = [...targets]
      .map((target) => posix.normalize(target))
      .filter((target) => !packed.has(target))
      .sort();
    expect(targets.size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('keeps deferred modules that nothing shipped imports out of the package', () => {
    const deferred = [
      /^dist\/(?:cjs\/)?openapi\//,
      /^dist\/(?:cjs\/)?server\/adapters\/nestjs\//,
      /^dist\/(?:cjs\/)?react\/transports\/langgraph/,
      /^dist\/(?:cjs\/)?codegen\/(?:skill-generator|mcp-generator|output-recommender|asset-sync|nestjs-scanner|endpoint-scanner|ui-scanner|module-generator|validator|coverage|scaffolder)\./,
      /^dist\/(?:cjs\/)?cli\/commands\/(?:check-upgrade|test)\./,
      /^dist\/(?:cjs\/)?cli\/utils\//,
    ];
    const leaked = [...packed].filter((path) => deferred.some((pattern) => pattern.test(path))).sort();
    expect(leaked).toEqual([]);
  });
});
