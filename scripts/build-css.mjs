// Writes the shipped stylesheets into dist/ and dist/cjs/ from the single
// hand-maintained sources in src/react/. The default files are wrapped in
// `@layer glirastes { ... }` so app utilities (Tailwind v4) override them; the
// `*.unlayered.css` files are the unchanged sources for apps whose global
// unlayered resets must not beat the SDK styles.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const LAYER_NAME = 'glirastes';

export function layered(css) {
  if (/^\s*@import\b/m.test(css)) {
    throw new Error('A stylesheet with @import cannot be wrapped in a layer block.');
  }
  return `@layer ${LAYER_NAME} {\n${css.replace(/\n*$/, '\n')}}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of ['styles', 'pills']) {
    const source = readFileSync(join(ROOT, `src/react/${name}.css`), 'utf8');
    for (const dir of ['dist/react', 'dist/cjs/react']) {
      mkdirSync(join(ROOT, dir), { recursive: true });
      writeFileSync(join(ROOT, dir, `${name}.css`), layered(source));
      writeFileSync(join(ROOT, dir, `${name}.unlayered.css`), source);
    }
  }
}
