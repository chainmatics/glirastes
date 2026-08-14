import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeArtifactSetAtomically } from './atomic-artifact-write.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-atomic-write-'));
  await mkdir(join(root, '.glirastes'), { recursive: true });
  const paths = ['a.json', 'b.json', 'c.json'].map((name) =>
    join(root, '.glirastes', name));
  await Promise.all(paths.map((path, index) => writeFile(path, `old-${index}`)));
  return { root, paths };
}

describe('writeArtifactSetAtomically', () => {
  it('restores every original byte when replacement fails midway', async () => {
    const { paths } = await fixture();
    await expect(writeArtifactSetAtomically(
      paths.map((path, index) => ({ path, content: `new-${index}` })),
      { afterReplace: (index) => {
        if (index === 0) throw new Error('injected replacement failure');
      } },
    )).rejects.toThrow('injected');

    await expect(Promise.all(paths.map((path) => readFile(path, 'utf8'))))
      .resolves.toEqual(['old-0', 'old-1', 'old-2']);
  });

  it('replaces the complete set and leaves no transaction files', async () => {
    const { root, paths } = await fixture();
    await writeArtifactSetAtomically(
      paths.map((path, index) => ({ path, content: `new-${index}` })),
    );
    await expect(Promise.all(paths.map((path) => readFile(path, 'utf8'))))
      .resolves.toEqual(['new-0', 'new-1', 'new-2']);
    expect((await readdir(join(root, '.glirastes'))).sort())
      .toEqual(['a.json', 'b.json', 'c.json']);
  });
});
