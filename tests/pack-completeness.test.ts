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

/**
 * Repository docs a shipped file may name without the package carrying them:
 * acceptance records and design material stay internal, so a reference to them
 * resolves against the repository only. Anything else under `docs/` that a
 * packed file names must be packed.
 */
const INTERNAL_DOCS = [/^docs\/acceptance(?:\/|$)/, /^docs\/plans(?:\/|$)/, /^docs\/deferred(?:\/|$)/];

/** Text files whose prose can point a reader at a repository doc. */
const REFERENCING_FILE = /\.(?:md|ya?ml|ts|mts|cts|js|mjs|cjs)$/;

/**
 * Every `docs/…` path a file names. Markdown link targets resolve against the
 * file's folder (`](tool-policy.md)` inside `docs/`, `](../docs/x.md)` from a
 * skill); bare mentions such as "see `docs/chat-queue.md`" name the repository
 * root. A `docs/` that follows a host or another path segment
 * (`glirastes.io/docs/chat`, `tree/main/docs`) is a web URL, not a package path.
 */
function docReferences(file: string, source: string): string[] {
  const found = new Set<string>();
  const clean = (path: string) => path.replace(/[.,;:]+$/, '').replace(/\/$/, '');
  for (const match of source.matchAll(/\]\(\s*<?([^)\s>#?]+)/g)) {
    const target = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (resolved.startsWith('docs/')) found.add(clean(resolved));
  }
  for (const match of source.matchAll(/(?<![\w.:/@-])((?:\.\.?\/)*)docs\/([\w./-]*[\w/])/g)) {
    const [, prefix, rest] = match;
    const resolved = prefix ? posix.normalize(posix.join(posix.dirname(file), `${prefix}docs/${rest}`)) : `docs/${rest}`;
    if (resolved.startsWith('docs/')) found.add(clean(resolved));
  }
  return [...found];
}

describe('package pack completeness', () => {
  it('ships every docs/ path that a packed file refers to, except internal records', async () => {
    const referencing = [...packed].filter((path) => REFERENCING_FILE.test(path));
    // Guards against a vacuous pass: these are the files that name docs today.
    expect(referencing).toContain('CHANGELOG.md');
    expect(referencing).toContain('README.md');
    expect(referencing.some((path) => path.startsWith('skills/'))).toBe(true);

    const missing = new Map<string, string[]>();
    let checked = 0;
    for (const file of referencing) {
      const source = await readFile(join(SDK_ROOT, file), 'utf8');
      for (const target of docReferences(file, source)) {
        checked += 1;
        if (INTERNAL_DOCS.some((pattern) => pattern.test(target))) continue;
        // A folder reference is satisfied by any packed file inside it.
        if (packed.has(target) || [...packed].some((path) => path.startsWith(`${target}/`))) continue;
        missing.set(target, [...(missing.get(target) ?? []), file]);
      }
    }
    expect(checked).toBeGreaterThan(20);

    const report = [...missing]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, files]) => `${target} <- ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}`);
    expect(report).toEqual([]);
  }, 60_000);

  it('resolves every relative Markdown link of a packed Markdown file inside the package', async () => {
    // Internal docs, examples, the container folder, tests and sources are not packed: a link to them is absolute.
    const broken: string[] = [];
    let checked = 0;
    for (const file of [...packed].filter((path) => path.endsWith('.md'))) {
      const source = await readFile(join(SDK_ROOT, file), 'utf8');
      for (const match of source.matchAll(/\]\(\s*<?([^)\s>#?]+)/g)) {
        const target = match[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
        checked += 1;
        const resolved = posix.normalize(posix.join(posix.dirname(file), target)).replace(/\/$/, '');
        if (packed.has(resolved) || [...packed].some((path) => path.startsWith(`${resolved}/`))) continue;
        broken.push(`${file} -> ${target}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(broken.sort()).toEqual([]);
  }, 60_000);

  it('keeps internal docs out of the package', () => {
    const leaked = [...packed].filter((path) => INTERNAL_DOCS.some((pattern) => pattern.test(path))).sort();
    expect(leaked).toEqual([]);
  });

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
