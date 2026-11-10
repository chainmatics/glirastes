import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const base = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(base, '../..');

/** A disposable Next app: the native app, the browser shell and its first `glirastes tools refresh`. */
export async function prepareBrowserReference() {
  const root = await mkdtemp(resolve(base, '.browser-proof-'));
  await cp(resolve(base, 'native'), root, { recursive: true });
  await cp(resolve(base, 'browser-shell'), root, { recursive: true });
  await mkdir(resolve(root, 'node_modules'));
  // This is the UNPUBLISHED local Foundation SDK, not registry glirastes@0.4.0.
  await symlink(sdk, resolve(root, 'node_modules/glirastes'), 'dir');
  for (const dependency of ['next', 'react', 'react-dom', '@ai-sdk/react', 'react-markdown', 'ai', 'zod']) {
    const target = resolve(root, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(resolve(sdk, 'node_modules', dependency)), target, 'dir');
  }
  // Without CI in the environment the refresh writes, exactly like the app's dev script.
  await promisify(execFile)(process.execPath, [resolve(sdk, 'dist/cli/bin.js'), 'tools', 'refresh', '--root', root],
    { env: { PATH: process.env.PATH ?? '' } });
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await prepareBrowserReference());
}
