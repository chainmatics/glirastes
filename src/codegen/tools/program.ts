import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { readVueScript, vueFileOf } from './sources/vue-sfc.js';

export interface AppProgram {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
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

/** Only the app's own tsconfig.json counts; parent configs never apply. */
export function readAppCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return defaultCompilerOptions();
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return defaultCompilerOptions();
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath).options;
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
}): AppProgram {
  if (input.rootNames.length > MAX_ROOT_FILES) throw unbounded();
  const options: ts.CompilerOptions = {
    ...readAppCompilerOptions(input.root),
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
