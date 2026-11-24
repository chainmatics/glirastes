import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Detect, UpgradeNote } from './notes.js';

export interface ScannedFile {
  path: string;
  text: string;
  glirastesImports: string[];
  /** Every module specifier with its offset; computed once by `scanApp`, lazily otherwise. */
  specifiers?: ReadonlyArray<{ spec: string; index: number }>;
}

export interface AppScan {
  files: ScannedFile[];
}

export interface NoteEvaluation {
  status: 'adopted' | 'affected' | 'not-affected' | 'unclear';
  evidence: Array<{ file: string; line: number }>;
}

/**
 * Style sheets are matched only for notes with `files: ['style']`, and for
 * `patterns` only: an `@import` of glirastes/react/styles.css is no code
 * import, so `imports` and `symbols` never match in them.
 */
const STYLE_EXTENSIONS = ['.css', '.scss', '.sass', '.less'] as const;

function isStyleFile(path: string): boolean {
  return (STYLE_EXTENSIONS as ReadonlyArray<string>).includes(extname(path));
}
const EXTENSIONS = new Set<string>([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.vue',
  '.svelte',
  '.astro',
  ...STYLE_EXTENSIONS,
]);
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.venv',
  '.claude',
  '.codex',
  '.glirastes',
  'storybook-static',
  '.docusaurus',
  '.cache',
]);
/** Lockfiles are large JSON that name every package, never app code. */
const IGNORED_FILES = new Set(['package-lock.json', 'bun.lock', 'npm-shrinkwrap.json']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EVIDENCE = 5;

// from '…', export … from '…', import '…', import('…'), require('…')
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

function isGlirastesSpecifier(spec: string): boolean {
  return spec === 'glirastes' || spec.startsWith('glirastes/');
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function parseSpecifiers(text: string): Array<{ spec: string; index: number }> {
  const re = new RegExp(SPECIFIER_RE.source, 'g');
  const out: Array<{ spec: string; index: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ spec: m[2]!, index: m.index });
  return out;
}

// Per-file caches for hand-built scans and line indexes; built on first use only.
const specifierCache = new WeakMap<ScannedFile, ReadonlyArray<{ spec: string; index: number }>>();
const lineStartCache = new WeakMap<ScannedFile, number[]>();

function fileSpecifiers(file: ScannedFile): ReadonlyArray<{ spec: string; index: number }> {
  if (file.specifiers) return file.specifiers;
  let cached = specifierCache.get(file);
  if (!cached) {
    cached = parseSpecifiers(file.text);
    specifierCache.set(file, cached);
  }
  return cached;
}

function fileLineStarts(file: ScannedFile): number[] {
  let cached = lineStartCache.get(file);
  if (!cached) {
    cached = lineStarts(file.text);
    lineStartCache.set(file, cached);
  }
  return cached;
}

async function walk(dir: string, root: string, out: AppScan['files']): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walk(full, root, out);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name)) && !IGNORED_FILES.has(entry.name)) {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await readFile(full, 'utf8');
      const specifiers = isStyleFile(entry.name) ? [] : parseSpecifiers(text);
      out.push({
        path: relative(root, full).split(sep).join('/'),
        text,
        glirastesImports: specifiers.map((s) => s.spec).filter(isGlirastesSpecifier),
        specifiers,
      });
    }
  }
}

export async function scanApp(root: string): Promise<AppScan> {
  const files: AppScan['files'] = [];
  await walk(root, root, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchDetect(detect: Detect, scan: AppScan): Array<{ file: string; line: number }> {
  const hits: Array<{ file: string; line: number }> = [];
  const imports = detect.imports ?? [];
  const symbolRes = (detect.symbols ?? []).map((s) => new RegExp(`\\b${escapeRegExp(s)}\\b`, 'g'));
  const patternRes = (detect.patterns ?? []).map((p) => new RegExp(p, 'mg'));

  // Symbols only count in files that import glirastes, so most files skip them.
  const withSymbols = [...symbolRes, ...patternRes];
  const kinds = detect.files ?? ['code'];
  for (const file of scan.files) {
    const style = isStyleFile(file.path);
    if (!kinds.includes(style ? 'style' : 'code')) continue;
    const offsets: number[] = [];

    if (!style && imports.length > 0 && (file.glirastesImports.length > 0 || !imports.every(isGlirastesSpecifier))) {
      for (const { spec, index } of fileSpecifiers(file)) {
        if (imports.some((i) => spec === i || spec.startsWith(`${i}/`))) offsets.push(index);
      }
    }
    const regexes = !style && file.glirastesImports.length > 0 ? withSymbols : patternRes;
    for (const re of regexes) {
      re.lastIndex = 0;
      for (let m = re.exec(file.text); m; m = re.exec(file.text)) {
        offsets.push(m.index);
        if (m[0] === '') re.lastIndex++;
      }
    }
    if (offsets.length === 0) continue;
    // The line index is built on the first hit in a file and reused across notes.
    const starts = fileLineStarts(file);
    const lines = new Set(offsets.map((offset) => lineAt(starts, offset)));
    for (const line of [...lines].sort((a, b) => a - b)) hits.push({ file: file.path, line });
  }
  return hits;
}

export function evaluateNote(note: UpgradeNote, scan: AppScan): NoteEvaluation {
  if (note.adoptedWhen) {
    const hits = matchDetect(note.adoptedWhen, scan);
    if (hits.length > 0) return { status: 'adopted', evidence: hits.slice(0, MAX_EVIDENCE) };
  }
  if (!note.affectedWhen) return { status: 'unclear', evidence: [] };
  const hits = matchDetect(note.affectedWhen, scan);
  if (hits.length > 0) return { status: 'affected', evidence: hits.slice(0, MAX_EVIDENCE) };
  return { status: 'not-affected', evidence: [] };
}
