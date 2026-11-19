import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Detect, UpgradeNote } from './notes.js';

export interface AppScan {
  files: Array<{ path: string; text: string; glirastesImports: string[] }>;
}

export interface NoteEvaluation {
  status: 'adopted' | 'affected' | 'not-affected' | 'unclear';
  evidence: Array<{ file: string; line: number }>;
}

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte']);
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.claude',
  '.codex',
  '.glirastes',
]);
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
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
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

function* specifiers(text: string): Generator<{ spec: string; index: number }> {
  const re = new RegExp(SPECIFIER_RE.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    yield { spec: m[2]!, index: m.index };
  }
}

async function walk(dir: string, root: string, out: AppScan['files']): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walk(full, root, out);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await readFile(full, 'utf8');
      const glirastesImports: string[] = [];
      for (const { spec } of specifiers(text)) {
        if (isGlirastesSpecifier(spec)) glirastesImports.push(spec);
      }
      out.push({
        path: relative(root, full).split(sep).join('/'),
        text,
        glirastesImports,
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

  for (const file of scan.files) {
    const starts = lineStarts(file.text);
    const lines = new Set<number>();

    if (imports.length > 0) {
      for (const { spec, index } of specifiers(file.text)) {
        if (imports.some((i) => spec === i || spec.startsWith(`${i}/`))) {
          lines.add(lineAt(starts, index));
        }
      }
    }
    const regexes = file.glirastesImports.length > 0 ? [...symbolRes, ...patternRes] : patternRes;
    for (const re of regexes) {
      re.lastIndex = 0;
      for (let m = re.exec(file.text); m; m = re.exec(file.text)) {
        lines.add(lineAt(starts, m.index));
        if (m[0] === '') re.lastIndex++;
      }
    }
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
