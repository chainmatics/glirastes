import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

  it.skipIf(process.platform === 'win32')(
    'keeps the mode of an existing target only for writes that ask for it',
    async () => {
      const { root, paths } = await fixture();
      const [kept, secret] = paths;
      await chmod(kept, 0o644);
      await chmod(secret, 0o644);
      const missing = join(root, '.glirastes', 'created.json');
      await writeArtifactSetAtomically([
        { path: kept, content: 'new-kept', preserveMode: true },
        { path: secret, content: 'new-secret' },
        { path: missing, content: 'new-created', preserveMode: true },
      ]);
      const mode = async (path: string) => (await stat(path)).mode & 0o777;
      expect(await mode(kept)).toBe(0o644);
      expect(await mode(secret)).toBe(0o600);
      expect(await mode(missing)).toBe(0o600);
      expect(await readFile(kept, 'utf8')).toBe('new-kept');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores the original mode together with the bytes when replacement fails',
    async () => {
      const { paths } = await fixture();
      await Promise.all(paths.map((path) => chmod(path, 0o644)));
      await expect(writeArtifactSetAtomically(
        paths.map((path, index) => ({ path, content: `new-${index}`, preserveMode: index === 0 })),
        { afterReplace: (index) => {
          if (index === 1) throw new Error('injected replacement failure');
        } },
      )).rejects.toThrow('injected');
      await expect(Promise.all(paths.map(async (path) => (await stat(path)).mode & 0o777)))
        .resolves.toEqual([0o644, 0o644, 0o644]);
      await expect(Promise.all(paths.map((path) => readFile(path, 'utf8'))))
        .resolves.toEqual(['old-0', 'old-1', 'old-2']);
    },
  );
});
