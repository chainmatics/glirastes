// ESM loader hooks for the glirastes tools schema probe child only. Transpiles
// app TypeScript/JSX with the SDK's TypeScript, maps `.js` imports to `.ts`
// sources and resolves tsconfig path aliases. Never used by the app runtime.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts'];
let ts;
let appRoot;
let sdkSourceRoot;
let compilerOptions;

function readCompilerOptions(root) {
  const fallback = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
  };
  const configPath = join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  return { ...ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath).options, allowJs: true };
}

export async function initialize(data) {
  ts = (await import(data.typescriptUrl)).default;
  appRoot = data.appRoot;
  sdkSourceRoot = data.sdkSourceRoot ?? undefined;
  compilerOptions = readCompilerOptions(appRoot);
}

function inside(base, path) {
  if (!base) return false;
  const local = relative(base, path);
  return Boolean(local) && !local.startsWith('..') && !isAbsolute(local) && !local.split(sep).includes('node_modules');
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveRelative(specifier, parentPath) {
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined;
  const base = isAbsolute(specifier) ? specifier : join(dirname(parentPath), specifier);
  const stem = base.replace(/\.(?:js|jsx|mjs)$/, '');
  return [
    base,
    ...SCRIPT_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ].find(isFile);
}

function resolveWithCompiler(specifier, parentPath) {
  const resolved = ts.resolveModuleName(specifier, parentPath, compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (!resolved || resolved.endsWith('.d.ts') || !inside(appRoot, resolved)) return undefined;
  return resolved;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const parentPath = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
    if (!parentPath || !(inside(appRoot, parentPath) || inside(sdkSourceRoot, parentPath))) throw error;
    const resolved = resolveRelative(specifier, parentPath) ?? resolveWithCompiler(specifier, parentPath);
    if (!resolved) throw error;
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const extension = extname(path);
  const typescriptSource = TYPESCRIPT_EXTENSIONS.includes(extension) && !path.endsWith('.d.ts');
  const appScript = inside(appRoot, path) && SCRIPT_EXTENSIONS.includes(extension);
  const sdkSource = inside(sdkSourceRoot, path) && typescriptSource;
  if (!appScript && !sdkSource) return nextLoad(url, context);
  const source = readFileSync(path, 'utf8');
  if (!typescriptSource && extension !== '.jsx' && !/^\s*(?:import|export)\b/m.test(source)) {
    return nextLoad(url, context);
  }
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: true,
      sourceMap: false,
    },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
