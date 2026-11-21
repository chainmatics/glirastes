import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpgradeNote } from './notes.js';
import { evaluateNote, scanApp } from './detect.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'glirastes-detect-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function note(over: Partial<UpgradeNote>): UpgradeNote {
  return {
    id: 'test-note',
    kind: 'breaking',
    summary: 's',
    howTo: 'h',
    skill: 'glirastes-setup',
    ...over,
  };
}

describe('detect', () => {
  it('import prefix: "glirastes/react" matches an import from "glirastes/react/vercel"', async () => {
    write('src/a.ts', "const x = 1;\nimport { y } from 'glirastes/react/vercel';\n");
    const r = evaluateNote(
      note({ affectedWhen: { imports: ['glirastes/react'] } }),
      await scanApp(root),
    );
    expect(r).toEqual({ status: 'affected', evidence: [{ file: 'src/a.ts', line: 2 }] });
  });

  it('import prefix does not match sibling names', async () => {
    write('a.ts', "import x from 'glirastes/reactive';\n");
    const r = evaluateNote(
      note({ affectedWhen: { imports: ['glirastes/react'] } }),
      await scanApp(root),
    );
    expect(r.status).toBe('not-affected');
  });

  it('symbols only count in files importing glirastes', async () => {
    write('a.ts', 'useStt();\n');
    write('b.ts', "import { x } from 'other';\nuseStt();\n");
    const n = note({ affectedWhen: { symbols: ['useStt'] } });
    expect(evaluateNote(n, await scanApp(root)).status).toBe('not-affected');
    write('c.ts', "import { useStt } from 'glirastes/react';\nuseStt();\n");
    const r = evaluateNote(n, await scanApp(root));
    expect(r.status).toBe('affected');
    expect(r.evidence.map((e) => e.file)).toEqual(['c.ts', 'c.ts']);
  });

  it('adoptedWhen wins over affectedWhen', async () => {
    write('a.ts', "import { x } from 'glirastes/server';\nx();\n");
    const r = evaluateNote(
      note({
        affectedWhen: { imports: ['glirastes/server'] },
        adoptedWhen: { symbols: ['x'] },
      }),
      await scanApp(root),
    );
    expect(r).toEqual({
      status: 'adopted',
      evidence: [
        { file: 'a.ts', line: 1 },
        { file: 'a.ts', line: 2 },
      ],
    });
  });

  it('pattern matches package.json script', async () => {
    write(
      'package.json',
      '{\n  "scripts": {\n    "sync:worklet": "cp audio-worklet-processor.js public/"\n  }\n}\n',
    );
    const r = evaluateNote(
      note({ affectedWhen: { patterns: ['audio-worklet-processor\\.js'] } }),
      await scanApp(root),
    );
    expect(r).toEqual({ status: 'affected', evidence: [{ file: 'package.json', line: 3 }] });
  });

  it('no affectedWhen -> unclear', async () => {
    write('a.ts', 'x\n');
    expect(evaluateNote(note({}), await scanApp(root))).toEqual({
      status: 'unclear',
      evidence: [],
    });
  });

  it('evidence capped at 5, sorted by file then line', async () => {
    write('b.ts', 'TODO\n'.repeat(4));
    write('a.ts', 'TODO\n'.repeat(4));
    const r = evaluateNote(
      note({ affectedWhen: { patterns: ['^TODO$'] } }),
      await scanApp(root),
    );
    expect(r.evidence).toHaveLength(5);
    expect(r.evidence[0]).toEqual({ file: 'a.ts', line: 1 });
    expect(r.evidence[4]).toEqual({ file: 'b.ts', line: 1 });
  });

  it("dynamic import('glirastes/server') and require('glirastes') are detected", async () => {
    write('a.ts', "const m = await import('glirastes/server');\n");
    write('b.cjs', 'const g = require("glirastes");\n');
    write('c.ts', "export * from 'glirastes/sync';\n");
    const scan = await scanApp(root);
    expect(scan.files.map((f) => f.glirastesImports)).toEqual([
      ['glirastes/server'],
      ['glirastes'],
      ['glirastes/sync'],
    ]);
    expect(
      evaluateNote(note({ affectedWhen: { imports: ['glirastes'] } }), scan).evidence,
    ).toHaveLength(3);
  });

  it('scan skips files over 1 MB and ignored dirs', async () => {
    write('node_modules/p/a.ts', "import x from 'glirastes/react';\n");
    write('dist/a.ts', "import x from 'glirastes/react';\n");
    write('big.ts', `import x from 'glirastes/react';\n${'a'.repeat(1.1 * 1024 * 1024)}`);
    const scan = await scanApp(root);
    expect(scan.files).toEqual([]);
    expect(
      evaluateNote(note({ affectedWhen: { imports: ['glirastes/react'] } }), scan).status,
    ).toBe('not-affected');
  });

  it('scan skips build output, vendored dirs and lockfiles', async () => {
    for (const dir of ['out', '.output', '.vercel', '.svelte-kit', '.nuxt', '.venv', 'vendor', 'target']) {
      write(`${dir}/a.ts`, "import x from 'glirastes/react';\n");
    }
    write('package-lock.json', '{ "glirastes/react": 1 }\n');
    write('bun.lock', '{ "glirastes/react": 1 }\n');
    write('sub/package-lock.json', '{ "glirastes/react": 1 }\n');
    write('src/keep.ts', "import x from 'glirastes/react';\n");
    expect((await scanApp(root)).files.map((f) => f.path)).toEqual(['src/keep.ts']);
  });

  it('scans .mts, .cts and .astro files', async () => {
    write('a.mts', "import x from 'glirastes/server';\n");
    write('b.cts', "const g = require('glirastes');\n");
    write('c.astro', "---\nimport { Chat } from 'glirastes/react';\n---\n");
    const scan = await scanApp(root);
    expect(scan.files.map((f) => [f.path, f.glirastesImports])).toEqual([
      ['a.mts', ['glirastes/server']],
      ['b.cts', ['glirastes']],
      ['c.astro', ['glirastes/react']],
    ]);
  });

  it('works on hand-built scans without precomputed specifiers', () => {
    const scan = { files: [{ path: 'a.ts', text: "\nimport x from 'glirastes/react';\n", glirastesImports: ['glirastes/react'] }] };
    expect(evaluateNote(note({ affectedWhen: { imports: ['glirastes/react'] } }), scan)).toEqual({
      status: 'affected',
      evidence: [{ file: 'a.ts', line: 2 }],
    });
  });

  // Coarse guard against per-note work over every file (the omnify case: ~1,400
  // files, 13 notes, 1 s). Files are ~6 KB like a real app. The bounds (1500 ms
  // in total, 800 ms for evaluation alone) are generous so slow CI machines
  // pass; per-note line indexing or specifier parsing lands above them.
  it('scans 2,000 files and evaluates 15 notes in under 1500 ms', async () => {
    const body = Array.from({ length: 150 }, (_, i) => `export const value${i} = compute(${i}); // filler line\n`).join('');
    for (let i = 0; i < 2000; i++) {
      const header = i % 10 === 0 ? "import { AiChatProvider } from 'glirastes/react';\n" : "import { x } from 'other';\n";
      write(`src/m${i % 40}/f${i}.ts`, header + body);
    }
    const notes = Array.from({ length: 15 }, (_, i) =>
      note({
        id: `perf-note-${i}`,
        affectedWhen: {
          imports: ['glirastes/react'],
          symbols: [`Symbol${i}`, 'AiChatProvider'],
          patterns: [`NeverPresent${i}\\b`, ':\\s*ChatLocale\\b'],
        },
        adoptedWhen: { patterns: [`alsoNever${i}`] },
      }),
    );
    const started = performance.now();
    const scan = await scanApp(root);
    const scanned = performance.now();
    const results = notes.map((n) => evaluateNote(n, scan));
    const finished = performance.now();
    expect(scan.files).toHaveLength(2000);
    expect(results.every((r) => r.status === 'affected')).toBe(true);
    expect(finished - scanned).toBeLessThan(800);
    expect(finished - started).toBeLessThan(1500);
  }, 20_000);
});
