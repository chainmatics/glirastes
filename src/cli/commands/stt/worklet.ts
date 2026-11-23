import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';

/** File name of the PCM worklet; browsers load it from `/audio-worklet-processor.js` by default. */
export const AUDIO_WORKLET_FILE = 'audio-worklet-processor.js';
/** Package export of the worklet (`require.resolve` / bundler `?url` imports). */
export const AUDIO_WORKLET_EXPORT = 'glirastes/react/audio-worklet-processor.js';
/** The command `glirastes init` chains into predev and prebuild. */
export const AUDIO_WORKLET_COMMAND = 'glirastes stt worklet';

export interface ProvideAudioWorkletResult {
  path: string;
  status: 'written' | 'unchanged';
}

/** The worklet shipped in this package (`dist/react/audio-worklet-processor.js`). */
export function findPackagedAudioWorklet(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    for (const candidate of [join(dir, 'react', AUDIO_WORKLET_FILE), join(dir, 'dist', 'react', AUDIO_WORKLET_FILE)]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new FoundationDiagnosticError({
    code: 'E-STT-004',
    operation: 'stt worklet',
    message: `The packaged ${AUDIO_WORKLET_FILE} was not found.`,
    remediation: 'Reinstall glirastes (npm install glirastes) and run glirastes stt worklet again.',
  });
}

/**
 * Copies the packaged audio worklet to `<root>/<out>/audio-worklet-processor.js`
 * (default `public/`, served at `/audio-worklet-processor.js` by Next.js and
 * Vite). Idempotent: an identical copy is left untouched.
 */
export async function provideAudioWorklet(options: {
  root: string;
  out?: string;
  source?: string;
}): Promise<ProvideAudioWorkletResult> {
  // The source map stays in the package; served without it, the browser asks for nothing else.
  const content = Buffer.from(
    (await readFile(options.source ?? findPackagedAudioWorklet(), 'utf8'))
      .replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'),
  );
  const path = resolve(options.root, options.out ?? 'public', AUDIO_WORKLET_FILE);
  try {
    if ((await readFile(path)).equals(content)) return { path, status: 'unchanged' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  // A dev server reading the file mid-write never sees half of it.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
  return { path, status: 'written' };
}

/** The entry for a copy at `relativePath` (root-relative, `/` separators): `/public/audio-worklet-processor.js` by default. */
export function audioWorkletGitignoreEntry(relativePath = `public/${AUDIO_WORKLET_FILE}`): string {
  return `/${relativePath.replace(/^\/+/, '')}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The .gitignore with the copied worklet listed, or `undefined` when it is
 * listed already (at its path, with or without leading slash, or by its bare
 * file name). The copy is a build output; init and `glirastes stt worklet`
 * add the same entry.
 */
export function withAudioWorkletGitignoreEntry(gitignore: string, relativePath?: string): string | undefined {
  const entry = audioWorkletGitignoreEntry(relativePath);
  const listed = new RegExp(`^(?:/?${escapeRegExp(entry.slice(1))}|/?${escapeRegExp(AUDIO_WORKLET_FILE)})\\s*$`, 'm');
  if (listed.test(gitignore)) return undefined;
  const separator = gitignore === '' ? '' : gitignore.endsWith('\n') ? '\n' : '\n\n';
  return `${gitignore}${separator}# Copied by ${AUDIO_WORKLET_COMMAND}\n${entry}\n`;
}
