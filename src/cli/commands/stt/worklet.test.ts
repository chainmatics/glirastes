import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSttCommand, STT_SUBCOMMANDS } from './index.js';
import { AUDIO_WORKLET_FILE, provideAudioWorklet } from './worklet.js';

let root: string;
let source: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glirastes-worklet-'));
  source = join(root, 'packaged.js');
  await writeFile(source, 'registerProcessor("audio-processor", class {});\n');
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
}

describe('provideAudioWorklet', () => {
  it('copies the packaged worklet into public/ and leaves an identical copy alone', async () => {
    const first = await provideAudioWorklet({ root, source });
    expect(first).toEqual({ path: join(root, 'public', AUDIO_WORKLET_FILE), status: 'written' });
    expect(await readFile(first.path, 'utf8')).toBe(await readFile(source, 'utf8'));
    const written = (await stat(first.path)).mtimeMs;

    const second = await provideAudioWorklet({ root, source });
    expect(second.status).toBe('unchanged');
    expect((await stat(first.path)).mtimeMs).toBe(written);
  });

  it('replaces an outdated copy and honours --out', async () => {
    await mkdir(join(root, 'static'), { recursive: true });
    await writeFile(join(root, 'static', AUDIO_WORKLET_FILE), 'old');
    const result = await provideAudioWorklet({ root, out: 'static', source });
    expect(result.status).toBe('written');
    expect(await readFile(join(root, 'static', AUDIO_WORKLET_FILE), 'utf8')).toContain('registerProcessor');
  });

  // The packaged file exists only after `bun run build`; the gate builds first.
  const built = join(process.cwd(), 'dist/react', AUDIO_WORKLET_FILE);
  it.skipIf(!existsSync(built))('finds the worklet shipped with the package by default (needs bun run build)', async () => {
    const result = await provideAudioWorklet({ root });
    const copied = await readFile(result.path, 'utf8');
    expect(copied).toContain("registerProcessor('audio-processor'");
    expect(copied).not.toContain('sourceMappingURL');
    expect(copied).toBe((await readFile(built, 'utf8')).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'));
  });
});

describe('glirastes stt worklet', () => {
  it('copies and reports the file, as text or JSON', async () => {
    const lines = io();
    expect(await runSttCommand(['worklet', '--root', root], { workletSource: source, ...lines })).toBe(0);
    expect(lines.out.join('\n')).toContain(`public/${AUDIO_WORKLET_FILE}`);
    const json = io();
    expect(await runSttCommand(['worklet', '--root', root, '--json'], { workletSource: source, ...json })).toBe(0);
    expect(JSON.parse(json.out[0]!)).toEqual({ path: `public/${AUDIO_WORKLET_FILE}`, status: 'unchanged', gitignore: 'none' });
    // Without a .gitignore none is created.
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('lists the copy in an existing .gitignore once, at the path it wrote', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules');
    const first = io();
    expect(await runSttCommand(['worklet', '--root', root], { workletSource: source, ...first })).toBe(0);
    expect(await readFile(join(root, '.gitignore'), 'utf8'))
      .toBe(`node_modules\n\n# Copied by glirastes stt worklet\n/public/${AUDIO_WORKLET_FILE}\n`);
    expect(first.out.join('\n')).toContain(`Added /public/${AUDIO_WORKLET_FILE} to .gitignore`);
    const again = io();
    expect(await runSttCommand(['worklet', '--root', root, '--json'], { workletSource: source, ...again })).toBe(0);
    expect(JSON.parse(again.out[0]!)).toMatchObject({ gitignore: 'listed' });

    const other = io();
    expect(await runSttCommand(['worklet', '--root', root, '--out', 'web/static', '--json'], { workletSource: source, ...other })).toBe(0);
    expect(JSON.parse(other.out[0]!)).toEqual({ path: `web/static/${AUDIO_WORKLET_FILE}`, status: 'written', gitignore: 'added' });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain(`\n/web/static/${AUDIO_WORKLET_FILE}\n`);
  });

  it('leaves the .gitignore alone with --no-gitignore, an entry by file name, or a copy outside the root', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    const skipped = io();
    expect(await runSttCommand(['worklet', '--root', root, '--no-gitignore', '--json'], { workletSource: source, ...skipped })).toBe(0);
    expect(JSON.parse(skipped.out[0]!)).toMatchObject({ gitignore: 'skipped' });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');

    await writeFile(join(root, '.gitignore'), `${AUDIO_WORKLET_FILE}\n`);
    const byName = io();
    expect(await runSttCommand(['worklet', '--root', root, '--out', 'static', '--json'], { workletSource: source, ...byName })).toBe(0);
    expect(JSON.parse(byName.out[0]!)).toMatchObject({ gitignore: 'listed' });

    const outside = io();
    expect(await runSttCommand(['worklet', '--root', join(root, 'app'), '--out', '../shared', '--json'], { workletSource: source, ...outside })).toBe(0);
    expect(JSON.parse(outside.out[0]!)).toMatchObject({ gitignore: 'none' });
  });

  it('is a declared subcommand', () => {
    expect(STT_SUBCOMMANDS.worklet).toEqual({ flags: ['--json', '--no-gitignore'], values: ['--out', '--root'] });
  });
});
