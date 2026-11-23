import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/generate-layered-styles.mjs', import.meta.url));
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};
const layered = () => execFileSync(process.execPath, [script, '--stdout'], { encoding: 'utf8' });

describe('styles.layered.css', () => {
  it('is styles.css inside @layer glirastes and nothing else', () => {
    const out = layered();
    const match = /^(\/\*[\s\S]*?\*\/\n)@layer glirastes \{\n([\s\S]*)\}\n$/.exec(out);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/styles\.css/);
    // Content-identical apart from the header comment and the layer wrapper.
    expect(match![2]).toBe(css.endsWith('\n') ? css : `${css}\n`);
  });

  it('the source has nothing that would change meaning or break inside a layer', () => {
    // @import, @charset and @namespace are invalid inside a block; a nested @layer would rename layers.
    expect(css).not.toMatch(/@(import|charset|namespace|layer)\b/);
    // Layered @font-face and @property are not covered by the content test; there are none.
    expect(css).not.toMatch(/@(font-face|property)\b/);
  });

  it('the build writes it next to styles.css and the package exports it', () => {
    expect(packageJson.exports['./react/styles.layered.css']).toBe('./dist/react/styles.layered.css');
    expect(packageJson.exports['./react/styles.css']).toBe('./dist/react/styles.css');
    expect(packageJson.scripts.build).toContain('node scripts/generate-layered-styles.mjs');
  });

  it('the generator refuses a source that cannot be wrapped', () => {
    const run = (input: string) => execFileSync(process.execPath, [script, '--stdin', '--stdout'], { encoding: 'utf8', input, stdio: 'pipe' });
    expect(run('a { color: red; }\n')).toContain('@layer glirastes {\na { color: red; }\n}\n');
    for (const rule of ['@import url("x.css");', '@charset "utf-8";', '@layer app;', '@font-face { font-family: x; }']) {
      expect(() => run(`${rule}\na { color: red; }\n`), rule).toThrow(/cannot be wrapped/);
    }
  });
});
