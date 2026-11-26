import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without declarations
import { layered } from '../../scripts/build-css.mjs';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, string>;
  scripts: Record<string, string>;
};

function balanced(css: string): boolean {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe.each(['styles.css', 'pills.css'])('%s layering', (name) => {
  const source = read(name);
  const wrapped = layered(source) as string;

  it('keeps the source unlayered and parseable', () => {
    expect(source).not.toContain('@layer glirastes');
    expect(source).not.toMatch(/^\s*@import\b/m);
    expect(balanced(source)).toBe(true);
  });

  it('wraps every rule of the shipped file in one @layer glirastes block', () => {
    expect(wrapped.startsWith('@layer glirastes {\n')).toBe(true);
    expect(wrapped.trimEnd().endsWith('}')).toBe(true);
    expect(wrapped.match(/@layer glirastes/g)).toHaveLength(1);
    expect(wrapped).toContain(source.trim());
    expect(balanced(wrapped)).toBe(true);
  });
});

describe('stylesheet exports', () => {
  it('exports the layered and the unlayered files and builds both from the sources', () => {
    expect(manifest.exports['./react/styles.css']).toBe('./dist/react/styles.css');
    expect(manifest.exports['./react/styles.unlayered.css']).toBe('./dist/react/styles.unlayered.css');
    expect(manifest.exports['./react/pills.css']).toBe('./dist/react/pills.css');
    expect(manifest.exports['./react/pills.unlayered.css']).toBe('./dist/react/pills.unlayered.css');
    expect(manifest.scripts.build).toContain('node scripts/build-css.mjs');
  });
});

describe('chat view in a message bubble', () => {
  it('gives a bubble with a chat view a definite width, capped by the bubble max-width', () => {
    const css = read('styles.css');
    const rule = css.match(/\[data-component="message-bubble"\]\[data-has-chat-view\] \{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/width:\s*100%/);
    expect(css).toMatch(/\[data-component="message-bubble"\] \{\s*max-width: 85%/);
    expect(css).toMatch(/\[data-component="chat-view"\][^{]*\{\s*min-width: 0;\s*max-width: 100%/);
  });
});
