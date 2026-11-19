import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeApiSurface, githubSlug } from '../scripts/api-surface.js';
import { evaluateNote } from './cli/commands/upgrade/detect.js';
import { loadUpgradeNotes } from './cli/commands/upgrade/notes.js';
import { SDK_VERSION } from './runtime/sdk-version.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const notesDir = join(repoRoot, 'upgrade-notes');
const skillsDir = join(repoRoot, 'skills');

async function unreleasedNoteIds(): Promise<Set<string>> {
  const dir = join(notesDir, 'unreleased');
  if (!existsSync(dir)) return new Set();
  const ids = new Set<string>();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as { id?: unknown };
    if (typeof parsed.id === 'string') ids.add(parsed.id);
  }
  return ids;
}

async function headingSlugs(skill: string): Promise<Set<string>> {
  const files = [join(skillsDir, skill, 'SKILL.md')];
  const refs = join(skillsDir, skill, 'references');
  if (existsSync(refs)) {
    for (const f of (await readdir(refs)).filter((f) => f.endsWith('.md'))) {
      files.push(join(refs, f));
    }
  }
  const slugs = new Set<string>();
  for (const file of files) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) slugs.add(githubSlug(m[1]!));
    }
  }
  return slugs;
}

describe('githubSlug', () => {
  it('lowercases, drops punctuation and turns spaces into hyphens', () => {
    expect(githubSlug('Install Skills')).toBe('install-skills');
    expect(githubSlug('Upgrade `--from` (0.18.0)!')).toBe('upgrade---from-0180');
    expect(githubSlug('Must, Should & Offer')).toBe('must-should--offer');
  });
});

describe('computeApiSurface', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-surface-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'glirastes',
        exports: {
          '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
          './react': { types: './dist/react/index.d.ts', default: './dist/react/index.js' },
          './react/styles.css': './dist/react/styles.css',
          './package.json': './package.json',
        },
      }),
    );
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, jsx: 'react-jsx' } }),
    );
    await mkdir(join(dir, 'src', 'react'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'index.ts'),
      [
        "export { helper as renamed } from './helper.js';",
        'export interface Options { a: string; nested: { deep: number } }',
        'export type Shape = { width: number; height: number };',
        "export type Kind = 'x' | 'y';",
        'export const VALUE = 1;',
      ].join('\n'),
    );
    await writeFile(join(dir, 'src', 'helper.ts'), 'export function helper(): void {}\n');
    await writeFile(
      join(dir, 'src', 'react', 'index.tsx'),
      "export type { ChatLocale } from './types.js';\nexport const Chat = () => null;\n",
    );
    await writeFile(
      join(dir, 'src', 'react', 'types.ts'),
      'export interface ChatLocale { sendButton: string; placeholder: string }\n',
    );
    return async () => rm(dir, { recursive: true, force: true });
  });

  it('lists exports, one level of members and locale keys, sorted', async () => {
    expect(await computeApiSurface(dir)).toEqual([
      'glirastes#Kind',
      'glirastes#Options',
      'glirastes#Options.a',
      'glirastes#Options.nested',
      'glirastes#Shape',
      'glirastes#Shape.height',
      'glirastes#Shape.width',
      'glirastes#VALUE',
      'glirastes#renamed',
      'glirastes/react#Chat',
      'glirastes/react#ChatLocale',
      'glirastes/react#ChatLocale.placeholder',
      'glirastes/react#ChatLocale.sendButton',
      'locale#placeholder',
      'locale#sendButton',
    ]);
  });
});

describe('upgrade notes guard', () => {
  let surface: string[];

  beforeAll(async () => {
    surface = await computeApiSurface(repoRoot);
  }, 120_000);

  it('all notes load without error', async () => {
    await expect(loadUpgradeNotes(notesDir, SDK_VERSION)).resolves.toBeInstanceOf(Array);
  });

  it('computes a non-trivial surface for the repo', () => {
    expect(surface).toContain('glirastes/react#ChatLocale');
    expect(surface.some((k) => k.startsWith('locale#'))).toBe(true);
    expect(surface.some((k) => k.startsWith('glirastes#'))).toBe(true);
    expect(surface.some((k) => k.endsWith('.css') || k.startsWith('glirastes/package.json'))).toBe(false);
  });

  it('every surface change since the released snapshot is covered by an unreleased note\'s surface list', async () => {
    const released = JSON.parse(
      await readFile(join(notesDir, 'api-surface.released.json'), 'utf8'),
    ) as string[];
    const current = new Set(surface);
    const before = new Set(released);
    const changed = [
      ...surface.filter((k) => !before.has(k)).map((k) => `+ ${k}`),
      ...released.filter((k) => !current.has(k)).map((k) => `- ${k}`),
    ];

    const unreleased = await unreleasedNoteIds();
    const notes = (await loadUpgradeNotes(notesDir, SDK_VERSION)).filter((n) =>
      unreleased.has(n.id),
    );
    const covered = new Set(notes.flatMap((n) => n.surface ?? []));
    const uncovered = changed.filter((c) => !covered.has(c.slice(2)));

    expect(
      uncovered,
      `Public API surface changed without an upgrade note:\n${uncovered.join('\n')}\n` +
        'Fix: add an upgrade note in upgrade-notes/unreleased/ listing these keys in `surface`, ' +
        'or run bun run api-surface after release.',
    ).toEqual([]);
  });

  it('every note\'s skill and anchor exist in skills/', async () => {
    const notes = await loadUpgradeNotes(notesDir, SDK_VERSION);
    const problems: string[] = [];
    for (const note of notes) {
      const [skill, anchor] = note.skill.split('#') as [string, string | undefined];
      if (!existsSync(join(skillsDir, skill, 'SKILL.md'))) {
        problems.push(`${note.id}: skill "${skill}" has no skills/${skill}/SKILL.md`);
        continue;
      }
      if (anchor !== undefined && !(await headingSlugs(skill)).has(anchor)) {
        problems.push(
          `${note.id}: anchor "#${anchor}" is not a ##/### heading in skills/${skill}/SKILL.md or references/*.md`,
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('shipped note detection', () => {
  const scanOf = (files: Record<string, string>) => ({
    files: Object.entries(files).map(([path, text]) => ({
      path,
      text,
      glirastesImports: [...text.matchAll(/from '(glirastes[^']*)'/g)].map((m) => m[1]!),
    })),
  });

  it('chat-locale-new-required-keys flags full ChatLocale objects, not every React app', async () => {
    const note = (await loadUpgradeNotes(notesDir, SDK_VERSION)).find((n) => n.id === 'chat-locale-new-required-keys')!;
    const plainReact = scanOf({
      'app/chat.tsx':
        "import { AiChatProvider, type ChatLocale } from 'glirastes/react';\n" +
        'const de: Partial<ChatLocale> = { sendButton: "Senden" };\n',
    });
    expect(evaluateNote(note, plainReact).status).toBe('not-affected');

    for (const usage of [
      'const de: ChatLocale = { sendButton: "Senden" };',
      'const de = { sendButton: "Senden" } satisfies ChatLocale;',
      'const de = { sendButton: "Senden" } as ChatLocale;',
      'const de = <ChatLocale>{ sendButton: "Senden" };',
      'const all: Record<string, ChatLocale> = {};',
      'const all = new Map<string,ChatLocale>();',
    ]) {
      const scan = scanOf({ 'app/locale.ts': `import type { ChatLocale } from 'glirastes/react';\n${usage}\n` });
      expect(evaluateNote(note, scan), usage).toMatchObject({
        status: 'affected',
        evidence: [{ file: 'app/locale.ts', line: 2 }],
      });
    }
  });
});
