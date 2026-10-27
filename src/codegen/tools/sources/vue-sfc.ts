import { readFileSync } from 'node:fs';

/**
 * A `.vue` file enters the TypeScript program as `<file>.vue.ts`: its
 * `<script>` and `<script setup>` blocks at their original offsets, every
 * other character blanked (newlines kept), so positions, line numbers and
 * relative imports stay those of the `.vue` file. Nothing is compiled.
 */
export const VUE_SCRIPT_SUFFIX = '.vue.ts';

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const READ_LANGUAGES = new Set(['ts', 'js']);

export type VueScript = { ok: true; text: string } | { ok: false; reason: string };

function attributesOf(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** The script blocks of one single-file component, or why they cannot be read. */
export function vueScriptOf(text: string): VueScript {
  const kept = text.replace(/[^\n]/g, ' ').split('');
  let blocks = 0;
  for (const match of text.matchAll(SCRIPT_BLOCK)) {
    blocks += 1;
    const attributes = attributesOf(match[1]!);
    if (attributes.has('src')) {
      return { ok: false, reason: 'loads its <script> from a src attribute; register UI actions in the script block or a .ts module.' };
    }
    const lang = attributes.get('lang') ?? 'js';
    if (!READ_LANGUAGES.has(lang)) {
      return { ok: false, reason: `has a <script lang="${lang}"> block; the generator reads ts and js script blocks only.` };
    }
    const start = match.index! + match[0].indexOf('>') + 1;
    const body = match[2]!;
    for (let offset = 0; offset < body.length; offset += 1) kept[start + offset] = body[offset]!;
  }
  if (blocks > 2) return { ok: false, reason: 'has more than one <script> and one <script setup> block.' };
  return { ok: true, text: kept.join('') };
}

/** The name a scanned file has in the TypeScript program: `<file>.vue.ts` for a `.vue` file. */
export function programFileName(absolute: string): string {
  return absolute.endsWith('.vue') ? `${absolute}.ts` : absolute;
}

/** The `.vue` file behind a `<file>.vue.ts` program name, or undefined for any other name. */
export function vueFileOf(fileName: string): string | undefined {
  return fileName.endsWith(VUE_SCRIPT_SUFFIX) ? fileName.slice(0, -'.ts'.length) : undefined;
}

/** The program text of a `<file>.vue.ts` name; undefined when the `.vue` file is missing or unreadable. */
export function readVueScript(fileName: string): string | undefined {
  const vue = vueFileOf(fileName);
  if (!vue) return undefined;
  let text: string;
  try {
    text = readFileSync(vue, 'utf8');
  } catch {
    return undefined;
  }
  const script = vueScriptOf(text);
  return script.ok ? script.text : undefined;
}
