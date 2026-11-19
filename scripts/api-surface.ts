/**
 * Computes the public API surface of the glirastes package as a sorted list
 * of keys, so CI can require an upgrade note for every surface change.
 *
 *   bun scripts/api-surface.ts          print the current surface
 *   bun scripts/api-surface.ts --write  write upgrade-notes/api-surface.released.json
 *
 * Keys:
 *   <subpath>#<Name>             every export of a public JS/TS subpath
 *   <subpath>#<Type>.<member>    members of exported interfaces and
 *                                type-alias object literals, one level deep
 *   locale#<key>                 keys of the ChatLocale type (src/react)
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type ExportTarget = string | { [condition: string]: ExportTarget | undefined };

/** GitHub-style heading slug: lowercase, keep letters/numbers/spaces/hyphens, spaces → `-`. */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

function typesPath(target: ExportTarget | undefined): string | undefined {
  if (target === undefined || typeof target === 'string') return undefined;
  if (typeof target.types === 'string') return target.types;
  return typesPath(target.import) ?? typesPath(target.default);
}

/** Maps `./dist/x/index.d.ts` to its source `src/x/index.ts` (or `.tsx`). */
function sourceEntry(repoRoot: string, dts: string): string {
  const rel = dts.replace(/^\.\//, '');
  if (!rel.startsWith('dist/') || !rel.endsWith('.d.ts')) {
    throw new Error(`Unexpected types path in package.json#exports: ${dts}`);
  }
  const base = join(repoRoot, 'src', rel.slice('dist/'.length, -'.d.ts'.length));
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(base + ext)) return base + ext;
  }
  throw new Error(`No source entry for ${dts} (looked for ${base}.ts/.tsx)`);
}

function subpathName(subpath: string): string {
  return subpath === '.' ? 'glirastes' : `glirastes/${subpath.replace(/^\.\//, '')}`;
}

function memberNames(checker: ts.TypeChecker, symbol: ts.Symbol): string[] {
  const isInterface = (symbol.flags & ts.SymbolFlags.Interface) !== 0;
  const isObjectAlias =
    (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0 &&
    (symbol.declarations ?? []).some(
      (d) => ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type),
    );
  if (!isInterface && !isObjectAlias) return [];
  return checker
    .getDeclaredTypeOfSymbol(symbol)
    .getProperties()
    .map((p) => p.getName());
}

function compilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = join(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  return { ...parsed.options, noEmit: true };
}

export async function computeApiSurface(repoRoot: string): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, ExportTarget>;
  };
  const entries: Array<{ name: string; file: string }> = [];
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    // JS/TS subpaths only: CSS and `./package.json`-style entries carry no types.
    const dts = typesPath(target);
    if (dts === undefined) continue;
    entries.push({ name: subpathName(subpath), file: sourceEntry(repoRoot, dts) });
  }

  const program = ts.createProgram(
    entries.map((e) => e.file),
    compilerOptions(repoRoot),
  );
  const checker = program.getTypeChecker();
  const keys = new Set<string>();

  for (const entry of entries) {
    const source = program.getSourceFile(entry.file);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`Cannot resolve module symbol for ${entry.file}`);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const name = exported.getName();
      keys.add(`${entry.name}#${name}`);
      const target =
        (exported.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exported)
          : exported;
      for (const member of memberNames(checker, target)) {
        keys.add(`${entry.name}#${name}.${member}`);
      }
    }
  }

  const reactDir = join(repoRoot, 'src', 'react') + sep;
  for (const source of program.getSourceFiles()) {
    if (!resolve(source.fileName).startsWith(reactDir)) continue;
    for (const statement of source.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === 'ChatLocale'
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) continue;
        for (const p of checker.getDeclaredTypeOfSymbol(symbol).getProperties()) {
          keys.add(`locale#${p.getName()}`);
        }
      }
    }
  }

  return [...keys].sort();
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const json = `${JSON.stringify(await computeApiSurface(repoRoot), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    const out = join(repoRoot, 'upgrade-notes', 'api-surface.released.json');
    await writeFile(out, json);
    console.log(`Wrote ${out}`);
  } else {
    process.stdout.write(json);
  }
}
