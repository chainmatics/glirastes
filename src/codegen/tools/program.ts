import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { TOOLS_PATHS } from './config.js';
import { readVueScript, vueFileOf } from './sources/vue-sfc.js';

export interface AppProgram {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** App-relative POSIX path of the tsconfig the program uses; undefined for TypeScript defaults. */
  readonly tsconfig: string | undefined;
  /** Absolute path of that tsconfig, for the schema probe of the same files. */
  readonly tsconfigPath: string | undefined;
  sourceFile(absolutePath: string): ts.SourceFile | undefined;
  /** App-relative POSIX path, or undefined for libraries, declarations and outside files. */
  appRelative(fileName: string): string | undefined;
}

const MAX_ROOT_FILES = 5_000;
const MAX_PROGRAM_FILES = 30_000;

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    types: [],
  };
}

/** Where a source looks for the tsconfig of the files it reads. */
export interface TsconfigLocation {
  /** App-relative folder the search starts at (the source's scanned folder); the app root by default. */
  searchFrom?: string;
  /** App-relative tsconfig named in `.glirastes/tools.json`; wins over the search and must exist. */
  tsconfig?: string;
  /** Absolute names of the files the program reads; they pick a project behind `references`. */
  rootNames?: ReadonlyArray<string>;
}

export interface AppCompilerConfig {
  /** Absolute path of the tsconfig used; undefined when TypeScript defaults apply. */
  path?: string;
  options: ts.CompilerOptions;
}

const MAX_REFERENCE_DEPTH = 4;
/** Lets a project's `include` match `.vue` files, so a Vue app finds its project behind `references`. */
const VUE_EXTENSION: ts.FileExtensionInfo[] = [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }];

function insideOrAt(base: string, path: string): boolean {
  const local = relative(base, path);
  return !local.startsWith('..') && !isAbsolute(local);
}

/** The nearest `tsconfig.json` from `start` up to the app root; never one above it. */
function nearestTsconfig(root: string, start: string): string | undefined {
  let directory = resolve(start);
  if (!insideOrAt(root, directory)) directory = root;
  for (;;) {
    const candidate = join(directory, 'tsconfig.json');
    if (ts.sys.fileExists(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

function parseTsconfig(configPath: string): ts.ParsedCommandLine | undefined {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return undefined;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath, undefined, VUE_EXTENSION);
}

/**
 * A solution-style tsconfig (`files: []` plus `references`, as Vite writes it)
 * holds no compiler options of the app: the referenced project that contains
 * one of the files does, as in the editor. Without a match the config itself counts.
 */
function projectFor(
  configPath: string,
  parsed: ts.ParsedCommandLine,
  files: ReadonlySet<string>,
  seen: Set<string>,
  depth: number,
): { path: string; parsed: ts.ParsedCommandLine } | undefined {
  if (parsed.fileNames.some((name) => files.has(resolve(name)))) return { path: configPath, parsed };
  if (depth >= MAX_REFERENCE_DEPTH) return undefined;
  for (const reference of parsed.projectReferences ?? []) {
    const referencePath = resolve(ts.resolveProjectReferencePath(reference));
    if (seen.has(referencePath)) continue;
    seen.add(referencePath);
    const child = parseTsconfig(referencePath);
    const found = child ? projectFor(referencePath, child, files, seen, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

function tsconfigUnreadable(path: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-TOOLS-002',
    operation: 'tools.config',
    message: `The Glirastes tools configuration is invalid: the tsconfig ${path} it names cannot be read.`,
    remediation: 'repair-tools-config',
    path: TOOLS_PATHS.config,
  });
}

/**
 * The tsconfig of the files a source reads: the one named in tools.json, else
 * the nearest `tsconfig.json` from the scanned folder up to the app root
 * (`extends`, `baseUrl` and `paths` as TypeScript reads them; a solution
 * config leads to the referenced project of the files). Configs above the app
 * root never apply; without one, TypeScript defaults do.
 */
export function resolveAppTsconfig(root: string, location: TsconfigLocation = {}): AppCompilerConfig {
  const appRoot = resolve(root);
  const configPath = location.tsconfig
    ? resolve(appRoot, location.tsconfig)
    : nearestTsconfig(appRoot, resolve(appRoot, location.searchFrom ?? '.'));
  if (!configPath) return { options: defaultCompilerOptions() };
  if (location.tsconfig && !existsSync(configPath)) throw tsconfigUnreadable(location.tsconfig);
  const parsed = parseTsconfig(configPath);
  if (!parsed) {
    if (location.tsconfig) throw tsconfigUnreadable(location.tsconfig);
    return { path: configPath, options: defaultCompilerOptions() };
  }
  if (location.rootNames && location.rootNames.length > 0 && (parsed.projectReferences?.length ?? 0) > 0) {
    const files = new Set(location.rootNames.map((name) => resolve(vueFileOf(name) ?? name)));
    const project = projectFor(configPath, parsed, files, new Set([resolve(configPath)]), 0);
    if (project) return { path: project.path, options: project.parsed.options };
  }
  return { path: configPath, options: parsed.options };
}

export function readAppCompilerOptions(root: string, location: TsconfigLocation = {}): ts.CompilerOptions {
  return resolveAppTsconfig(root, location).options;
}

function unbounded(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-INVENTORY-011',
    operation: 'tools.program',
    message: 'The app is too large for one bounded TypeScript program.',
    remediation: 'complete-source-discovery',
  });
}

/** One bounded, read-only program per app tsconfig. Never emits, never executes. */
export function createAppProgram(input: {
  root: string;
  rootNames: ReadonlyArray<string>;
  /** App-relative folder the source scans; the tsconfig search starts there. */
  searchFrom?: string;
  /** App-relative tsconfig named in tools.json. */
  tsconfig?: string;
}): AppProgram {
  if (input.rootNames.length > MAX_ROOT_FILES) throw unbounded();
  const config = resolveAppTsconfig(input.root, {
    rootNames: input.rootNames,
    ...(input.searchFrom ? { searchFrom: input.searchFrom } : {}),
    ...(input.tsconfig ? { tsconfig: input.tsconfig } : {}),
  });
  const options: ts.CompilerOptions = {
    ...config.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  // `<file>.vue.ts` names read the script blocks of `<file>.vue`; every other file is read as is.
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile } = host;
  host.fileExists = (fileName) => (vueFileOf(fileName) ? readVueScript(fileName) !== undefined : fileExists(fileName));
  host.readFile = (fileName) => (vueFileOf(fileName) ? readVueScript(fileName) : readFile(fileName));
  const program = ts.createProgram({ rootNames: [...input.rootNames].sort(), options, host });
  if (program.getSourceFiles().length > MAX_PROGRAM_FILES) throw unbounded();
  const checker = program.getTypeChecker();
  return {
    root: input.root,
    program,
    checker,
    tsconfig: config.path ? relative(resolve(input.root), config.path).split(/[\\/]/).join('/') : undefined,
    tsconfigPath: config.path,
    sourceFile: (absolutePath) => program.getSourceFile(absolutePath),
    appRelative(fileName) {
      if (fileName.endsWith('.d.ts')) return undefined;
      const local = relative(input.root, fileName);
      if (!local || local.startsWith('..') || isAbsolute(local)) return undefined;
      const segments = (vueFileOf(local) ?? local).split(/[\\/]/);
      if (segments.includes('node_modules')) return undefined;
      return segments.join('/');
    },
  };
}
