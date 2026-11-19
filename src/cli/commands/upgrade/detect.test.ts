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
});
