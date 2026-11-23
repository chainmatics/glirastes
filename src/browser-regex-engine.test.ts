/**
 * A browser module must load on an engine that lacks a newer regular
 * expression feature (Unicode property escapes, lookbehind, named groups, the
 * `s`, `v` and `d` flags): such a regex is built at call time, or guarded with
 * a documented fallback. A regex literal is parsed with its module, so the
 * browser-reachable modules may not contain one that uses these features.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Entry points of the subpaths an app loads in the browser. */
const BROWSER_ENTRIES = [
  'index.ts', // glirastes (definition helpers, also used in frontends)
  'contracts/index.ts',
  'react/index.ts',
  'react/transports/vercel/index.ts',
  'embed/index.ts',
  'browser/index.ts',
];

/** Syntax newer than ES2015 regular expressions; an older engine refuses it. */
function newerFeatures(source: string, flags: string): string[] {
  const found: string[] = [];
  if (/\\[pP]\{/.test(source)) found.push('Unicode property escape');
  if (/\(\?<[=!]/.test(source)) found.push('lookbehind');
  if (/\(\?<[A-Za-z_$]|\\k</.test(source)) found.push('named group');
  for (const flag of ['s', 'v', 'd']) if (flags.includes(flag)) found.push(`flag ${flag}`);
  return found;
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier).replace(/\.js$/, '');
  return ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((file) => existsSync(file));
}

/** Every source module a browser entry loads statically (type-only imports are erased). */
function browserModules(): string[] {
  const seen = new Set<string>();
  const stack = BROWSER_ENTRIES.map((entry) => resolve(SRC, entry));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      const next = resolveImport(file, statement.moduleSpecifier.text);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

function newerRegexLiterals(file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(source);
      const end = text.lastIndexOf('/');
      const features = newerFeatures(text.slice(1, end), text.slice(end + 1));
      if (features.length > 0) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${relative(SRC, file)}:${line} ${text} (${features.join(', ')})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const NativeRegExp = RegExp;

/** Replaces `RegExp` with one that refuses the newer syntax, like an engine without it. */
function simulateOlderEngine(): void {
  const check = (args: unknown[]) => {
    const [pattern, flags] = args;
    const source = pattern instanceof NativeRegExp ? pattern.source : String(pattern);
    const allFlags = typeof flags === 'string' ? flags : pattern instanceof NativeRegExp ? pattern.flags : '';
    const features = newerFeatures(source, allFlags);
    if (features.length > 0) throw new SyntaxError(`Invalid regular expression: /${source}/${allFlags}: ${features.join(', ')}`);
  };
  globalThis.RegExp = new Proxy(NativeRegExp, {
    construct(target, args, newTarget) {
      check(args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      check(args);
      return Reflect.apply(target, thisArg, args);
    },
  });
}

afterEach(() => {
  globalThis.RegExp = NativeRegExp;
});

describe('regular expressions in browser modules', () => {
  it('contain no literal with syntax an older engine refuses at load', () => {
    const modules = browserModules();
    expect(modules).toContain(resolve(SRC, 'react/components/recording-bar.tsx'));
    expect(modules.flatMap(newerRegexLiterals)).toEqual([]);
  });

  it('the simulated older engine refuses the newer syntax', () => {
    simulateOlderEngine();
    expect(() => new RegExp('\\p{L}', 'u')).toThrow(SyntaxError);
    expect(() => new RegExp('(?<!a)b')).toThrow(SyntaxError);
    expect(() => new RegExp('a.b', 's')).toThrow(SyntaxError);
    expect(new RegExp('[a-z]+', 'gu').test('abc')).toBe(true);
  });

  it.each(BROWSER_ENTRIES)('%s loads on an engine without them', async (entry) => {
    vi.resetModules();
    simulateOlderEngine();
    await expect(import(`./${entry.replace(/\.ts$/, '.js')}`)).resolves.toBeDefined();
  });
});

describe('Unicode text patterns', () => {
  async function load(older: boolean) {
    vi.resetModules();
    if (older) simulateOlderEngine();
    return import('./react/utils/unicode-text.js');
  }

  it('use Unicode properties where the engine has them', async () => {
    const text = await load(false);
    expect('Übersicht'.normalize('NFKD').replace(text.COMBINING_MARKS, '')).toBe('Ubersicht');
    expect('ру́сский'.normalize('NFKD').replace(text.COMBINING_MARKS, '')).toBe('русский');
    expect('erledigte-aufgaben (alle)'.split(text.NON_WORD_RUN)).toEqual(['erledigte', 'aufgaben', 'alle', '']);
    expect('𝒜b c'.split(text.NON_WORD_RUN)).toEqual(['𝒜b', 'c']);
    expect(text.WORD_CHARACTER.test('é')).toBe(true);
    expect(text.WORD_CHARACTER.test('-')).toBe(true);
    expect(text.WORD_CHARACTER.test(' ')).toBe(false);
    expect(text.STARTS_RIGHT_TO_LEFT.test('… שלום')).toBe(true);
    expect(text.STARTS_RIGHT_TO_LEFT.test('123 مرحبا')).toBe(true);
    expect(text.STARTS_RIGHT_TO_LEFT.test('hello שלום')).toBe(false);
  });

  it('fall back to Unicode block ranges on an engine without property escapes', async () => {
    const text = await load(true);
    expect(text.COMBINING_MARKS.unicode).toBe(false);
    // Combining Diacritical Marks and their supplements and extensions are removed.
    expect('Übersicht'.normalize('NFKD').replace(text.COMBINING_MARKS, '')).toBe('Ubersicht');
    expect('ру́сский'.normalize('NFKD').replace(text.COMBINING_MARKS, '')).toBe('русский');
    // Letters and digits of the Basic Multilingual Plane form words; ASCII and general punctuation split them.
    expect('erledigte-aufgaben (alle)'.split(text.NON_WORD_RUN)).toEqual(['erledigte', 'aufgaben', 'alle', '']);
    expect('übersicht öffnen…jetzt'.split(text.NON_WORD_RUN)).toEqual(['übersicht', 'öffnen', 'jetzt']);
    expect('задачи 任务'.split(text.NON_WORD_RUN)).toEqual(['задачи', '任务']);
    expect(text.WORD_CHARACTER.test('é')).toBe(true);
    expect(text.WORD_CHARACTER.test('_')).toBe(true);
    expect(text.WORD_CHARACTER.test(' ')).toBe(false);
    expect(text.WORD_CHARACTER.test('…')).toBe(false);
    // The first letter decides; Hebrew, Arabic, Syriac and Thaana blocks are right to left.
    expect(text.STARTS_RIGHT_TO_LEFT.test('… שלום')).toBe(true);
    expect(text.STARTS_RIGHT_TO_LEFT.test('123 مرحبا')).toBe(true);
    expect(text.STARTS_RIGHT_TO_LEFT.test('ހެލޯ')).toBe(true);
    expect(text.STARTS_RIGHT_TO_LEFT.test('hello שלום')).toBe(false);
    expect(text.STARTS_RIGHT_TO_LEFT.test('привет')).toBe(false);
  });

  it('keep the / command search working with the fallback', async () => {
    vi.resetModules();
    simulateOlderEngine();
    const { createUiToolCommandProvider } = await import('./react/completions/ui-tool-command-provider.js');
    const provider = createUiToolCommandProvider({
      tools: [
        { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen' },
        { definitionId: 'ui.filter.doneTasks', label: 'Erledigte Aufgaben filtern' },
      ],
    });
    const search = (query: string) => (provider.search({
      query, trigger: '/', signal: new AbortController().signal, context: { roles: [] }, limit: 8,
    }) as ReadonlyArray<{ id: string }>).map((item) => item.id);
    expect(search('ub')).toEqual(['ui.navigate.overview']);
    expect(search('offnen')).toEqual(['ui.navigate.overview']);
    expect(search('aufgaben')).toEqual(['ui.filter.doneTasks']);
  });

  it('keep data URLs with line breaks decodable without the s flag', async () => {
    vi.resetModules();
    simulateOlderEngine();
    const { dataUrlToBlob } = await import('./react/utils/attachment-blob-store.js');
    const blob = dataUrlToBlob(`data:text/plain;base64,${btoa('line one\nline two')}\n`);
    // atob ignores ASCII whitespace, so a payload broken across lines decodes as before.
    expect(blob?.type).toBe('text/plain');
    expect(await blob?.text()).toBe('line one\nline two');
    expect(dataUrlToBlob('data:text/plain,plain')).toBeNull();
  });
});
