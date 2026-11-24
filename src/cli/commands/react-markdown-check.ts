import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { scanApp, type AppScan } from './upgrade/detect.js';

/** Test files import the chat for their fixtures; they do not make the app render it. */
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The entry points that render chat answers as Markdown through react-markdown. */
const CHAT_ENTRY = /^glirastes\/(?:react|embed)(?:\/|$)/;

export interface ReactMarkdownInspection {
  /** A non-test source file imports `glirastes/react` (any subpath) or `glirastes/embed`. */
  chat: boolean;
  /**
   * `pass`: `node_modules/react-markdown` is found from the app folder upwards;
   * `missing`: not found while `glirastes` itself is;
   * `unknown`: dependencies are not installed (no `glirastes` found) or the
   * project uses Yarn Plug'n'Play, which this offline check cannot read.
   */
  status: 'pass' | 'missing' | 'unknown';
}

/** The folder of `node_modules/<name>` as Node looks it up from `root` (the folder and its parents). */
function installed(root: string, name: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function plugAndPlay(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.pnp.cjs')) || existsSync(join(dir, '.pnp.js'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Offline: the app renders the glirastes React chat (an import of
 * `glirastes/react` or `glirastes/embed` outside tests) and react-markdown,
 * an optional peer dependency, is installed where Node resolves it. Without
 * it every answer shows its raw Markdown source.
 */
export async function inspectReactMarkdown(rootDir: string, scan?: AppScan): Promise<ReactMarkdownInspection> {
  const root = resolve(rootDir);
  const files = (scan ?? await scanApp(root)).files;
  const chat = files.some((file) => !TEST_FILE.test(file.path)
    && file.glirastesImports.some((specifier) => CHAT_ENTRY.test(specifier)));
  if (!chat) return { chat, status: 'unknown' };
  if (plugAndPlay(root) || !installed(root, 'glirastes')) return { chat, status: 'unknown' };
  return { chat, status: installed(root, 'react-markdown') ? 'pass' : 'missing' };
}
