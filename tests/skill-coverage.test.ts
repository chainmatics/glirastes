import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Skills must not lag behind the public API: every name an integrator can import
 * from a package entry point, and every top-level option of the main config
 * types, appears in a shipped skill or is allowlisted with a reason.
 */
const ROOT = resolve(import.meta.dirname, '..');
const ALLOWLIST_PATH = 'tests/skill-coverage-allowlist.json';

/** Config types whose top-level keys integrators set; `Type.key` in the allowlist. */
const CONFIG_TYPES = [
  { file: 'src/server/adapters/nextjs/types.ts', name: 'AiChatHandlerConfig' },
] as const;

interface Allowlist {
  [name: string]: string;
}

function publicEntryFiles(): Map<string, string[]> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import?: { default?: string }; default?: string }>;
  };
  const entries = new Map<string, string[]>();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = typeof target === 'string' ? target : target.import?.default ?? target.default;
    if (!file?.endsWith('.js')) continue;
    const source = resolve(ROOT, file.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
    entries.set(source, [...(entries.get(source) ?? []), subpath]);
  }
  return entries;
}

function collectSurface(): Map<string, string[]> {
  const entries = publicEntryFiles();
  const program = ts.createProgram(
    [...entries.keys(), ...CONFIG_TYPES.map((type) => resolve(ROOT, type.file))],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      noEmit: true,
    },
  );
  const checker = program.getTypeChecker();
  // name → entry points that export it (export * and re-exports followed by the checker)
  const surface = new Map<string, string[]>();
  for (const [file, subpaths] of entries) {
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Cannot read the public entry point ${file}.`);
    for (const symbol of checker.getExportsOfModule(module)) {
      if (symbol.name === 'default') continue;
      surface.set(symbol.name, [...new Set([...(surface.get(symbol.name) ?? []), ...subpaths])]);
    }
  }
  for (const type of CONFIG_TYPES) {
    const source = program.getSourceFile(resolve(ROOT, type.file));
    const module = source && checker.getSymbolAtLocation(source);
    const symbol = module && checker.getExportsOfModule(module).find((candidate) => candidate.name === type.name);
    if (!symbol) throw new Error(`Cannot find ${type.name} in ${type.file}.`);
    for (const property of checker.getDeclaredTypeOfSymbol(symbol).getProperties()) {
      surface.set(`${type.name}.${property.name}`, [`${type.name} option`]);
    }
  }
  return surface;
}

function skillText(): string {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []
  ));
  return walk(join(ROOT, 'skills')).map((file) => readFileSync(file, 'utf8')).join('\n');
}

const COMPANION_SUFFIXES = ['Schema', 'Props', 'Options', 'Return', 'Config', 'Result', 'Input'] as const;

/**
 * Names that count as the mention of `name`: itself (an option key without its
 * type), and for a companion type the thing it belongs to (`FooSchema` → `Foo`,
 * `UseFooReturn` → `useFoo`, `FooOptions` → `createFoo`).
 */
function candidates(name: string): string[] {
  const word = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
  const result = [word];
  for (const suffix of COMPANION_SUFFIXES) {
    if (!word.endsWith(suffix) || word.length === suffix.length) continue;
    const base = word.slice(0, -suffix.length);
    result.push(base, `create${base}`);
    if (/^Use[A-Z]/.test(base)) result.push(`use${base.slice(3)}`);
  }
  return result;
}

function mentioned(text: string, name: string): boolean {
  return candidates(name).some((word) => (
    new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`).test(text)
  ));
}

describe('skill coverage of the public API', () => {
  const surface = collectSurface();
  const text = skillText();
  const allowlist = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), 'utf8')) as Allowlist;

  it('mentions every public export and config option in a skill, or allowlists it with a reason', () => {
    const missing = [...surface.keys()]
      .filter((name) => !mentioned(text, name) && !(name in allowlist))
      .sort();
    if (process.env.SKILL_COVERAGE_DUMP) {
      writeFileSync(process.env.SKILL_COVERAGE_DUMP, JSON.stringify(
        Object.fromEntries(missing.map((name) => [name, surface.get(name)!.join(', ')])),
        null,
        2,
      ));
    }
    expect(missing, [
      `${missing.length} public name(s) appear in no skill:`,
      ...missing.map((name) => `  - ${name} (${surface.get(name)!.join(', ')})`),
      'For each one, either:',
      '  1. mention it (as `code`) in the skill an integrator reads for it, e.g. skills/integrating-glirastes-nextjs',
      '     for server options, skills/building-glirastes-chat-ui for React, skills/maintaining-glirastes-tools for',
      '     tool contracts; put long detail into that skill\'s references/ file and keep SKILL.md lean; or',
      `  2. add it to ${ALLOWLIST_PATH} as "<name>": "<one-line reason an integrator never needs it>".`,
    ].join('\n')).toEqual([]);
  });

  it('keeps the allowlist free of stale entries and empty reasons', () => {
    const stale = Object.entries(allowlist)
      .filter(([name, reason]) => !surface.has(name) || mentioned(text, name) || reason.trim().length === 0)
      .map(([name]) => name)
      .sort();
    expect(stale, [
      `${ALLOWLIST_PATH} has entries to remove or fix:`,
      ...stale.map((name) => `  - ${name}: ${!surface.has(name)
        ? 'no longer public; remove the entry'
        : mentioned(text, name) ? 'now mentioned in a skill; remove the entry' : 'give a one-line reason'}`),
    ].join('\n')).toEqual([]);
  });
});
