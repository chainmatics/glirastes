import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolSourceKindSchema } from '../src/codegen/tools/config.js';

/**
 * The support matrix may say "automatically checked" only where the stack's
 * change corpus exists in full: endpoint, navigation and filter, each with an
 * add, a change and a remove test. The corpus tests run in the same gate, so a
 * failing corpus fails the release before this page can overstate it.
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(SDK_ROOT, path), 'utf8');
const MATRIX = read('docs/support-matrix.md');

/** The rows of the Markdown table under `## <heading>`, as cell arrays without the header. */
function table(heading: string): string[][] {
  const section = MATRIX.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0];
  expect(section, `section ${heading}`).toBeDefined();
  return section!.split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

const CORPUS_NAMES: Record<string, string> = {
  'Next.js 15 App Router': 'Next',
  'React (Vite, react-router) + NestJS 11': 'React+NestJS',
  'Vue 3 (vue-router) + FastAPI, Python 3.12': 'Vue+FastAPI',
};
const FIXTURES: Record<string, string> = {
  Next: 'examples/source-driven-next/native/.glirastes/tools.json',
  'React+NestJS': 'examples/react-nest-separate/.glirastes/tools.json',
  'Vue+FastAPI': 'examples/vue-fastapi/.glirastes/tools.json',
};

/** The `it(...)` titles inside `describe('<name>', ...)` (or `describe.skipIf(...)('<name>', ...)`) of the evidence files. */
function corpusTests(files: string[], name: string): string[] {
  const titles: string[] = [];
  for (const file of files) {
    const source = read(file);
    const start = source.search(new RegExp(`describe(?:\\.skipIf\\([^)]*\\))?\\('${name.replace(/[+.]/g, '\\$&')}'`));
    if (start < 0) continue;
    const next = source.indexOf('\ndescribe', start + 1);
    const block = source.slice(start, next < 0 ? undefined : next);
    titles.push(...[...block.matchAll(/\n {2}it\('([^']+)'/g)].map((match) => match[1]!));
  }
  return titles;
}

describe('support matrix', () => {
  const stacks = table('Stacks');

  it('lists the three reference stacks and the honest rest', () => {
    expect(stacks.map(([stack]) => stack)).toEqual([
      ...Object.keys(CORPUS_NAMES),
      'Next.js 16 App Router',
      'Other stacks (Express, Remix, Nuxt, Django, …)',
    ]);
    for (const row of stacks) expect(row, row[0]).toHaveLength(6);
  });

  it('claims "automatically checked" only with a full change corpus as evidence', () => {
    for (const [stack, , , checked, official, evidence] of stacks) {
      const corpus = CORPUS_NAMES[stack!];
      if (checked !== 'yes') {
        expect(official, `${stack} cannot be officially supported unchecked`).toBe('no');
        continue;
      }
      expect(corpus, `${stack} has no corpus`).toBeDefined();
      const files = [...evidence!.matchAll(/`(tests\/[^`]+\.test\.ts)`/g)].map((match) => match[1]!);
      expect(files.length, `${stack} evidence`).toBeGreaterThan(0);
      for (const file of files) expect(existsSync(join(SDK_ROOT, file)), file).toBe(true);
      for (const part of ['endpoint', 'navigation', 'filter']) {
        const titles = corpusTests(files, `${corpus} ${part} change corpus`);
        expect(titles.map((title) => title.split(' ')[0]), `${stack} ${part}`).toEqual(['adds', 'changes', 'removes']);
      }
    }
  });

  it('names every source kind, and each checking stack declares it in its fixture', () => {
    const kinds = table('Source kinds');
    expect(kinds.map(([kind]) => kind!.replace(/`/g, ''))).toEqual(ToolSourceKindSchema.options);
    for (const [kind, , checkedBy] of kinds) {
      const name = kind!.replace(/`/g, '');
      const stacksNamed = checkedBy!.startsWith('none') ? [] : checkedBy!.split(', ');
      for (const stack of stacksNamed) {
        const fixture = JSON.parse(read(FIXTURES[stack]!)) as { sources: Array<string | { kind: string }> };
        const declared = fixture.sources.map((source) => (typeof source === 'string' ? source : source.kind));
        expect(declared, `${stack} declares ${name}`).toContain(name);
      }
    }
  });
});
