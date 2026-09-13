import { cp, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReference } from './build.mjs';

const base = dirname(fileURLToPath(import.meta.url));
export async function prepareBrowserReference() {
  const root = await mkdtemp(resolve(base, '.browser-proof-'));
  await cp(resolve(base, 'native'), root, { recursive: true });
  await cp(resolve(base, 'native-ui'), resolve(root, 'src'), { recursive: true });
  await cp(resolve(base, 'ui-bridge.js'), resolve(root, 'src/glirastes-ui-bridge.js'));
  await cp(resolve(base, 'browser-shell'), root, { recursive: true });
  const setup = resolve(root, 'glirastes-setup');
  await mkdir(resolve(setup, 'native/src'), { recursive: true });
  for (const file of ['adapter.mjs', 'ui-adapter.mjs', 'build.mjs']) {
    await cp(resolve(base, file), resolve(setup, file));
  }
  // Fixed assessed query-wrapper baseline, not a second per-tool catalogue.
  await cp(resolve(base, 'native/src/query.js'), resolve(setup, 'native/src/query.js'));
  await mkdir(resolve(root, 'node_modules'));
  // This is the UNPUBLISHED local Foundation SDK, not registry glirastes@0.4.0.
  await symlink(resolve(base, '../..'), resolve(root, 'node_modules/glirastes'), 'dir');
  for (const dependency of ['next', 'react', 'react-dom', '@ai-sdk/react', 'react-markdown', 'ai', 'zod']) {
    const target = resolve(root, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(resolve(base, '../../node_modules', dependency)), target, 'dir');
  }
  await buildReference(root);
  return root;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await prepareBrowserReference());
}
