import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TOOLS_PATHS } from '../../codegen/tools/config.js';
import { scanApp, type AppScan } from './upgrade/detect.js';

/** Test files may define components for their fixtures; they do not make the app use chat views. */
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export interface ChatViewsZodInspection {
  /** A non-test file calls `defineChatComponent`, or `.glirastes/chat-components.json` exists. */
  chatViews: boolean;
  /**
   * `pass`: the zod Node resolves from the app folder is 4.x, or 3.25+ and no
   * definition file imports the classic `zod` entry;
   * `classic-import`: zod 3.25+ and a definition file imports `zod` (zod 3 classic);
   * `zod-too-old`: zod 3 below 3.25, which ships no `zod/v4`;
   * `unknown`: zod is not installed where Node resolves it.
   */
  status: 'pass' | 'classic-import' | 'zod-too-old' | 'unknown';
}

async function installedVersion(root: string, name: string): Promise<string | undefined> {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      try {
        const version = (JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' ? version : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Offline: an app with chat views on zod 3. Chat component props must be zod 4
 * schemas; zod 3.25 and later ship them as `zod/v4`, the classic `zod` entry
 * of zod 3 is refused when the component module loads.
 */
export async function inspectChatViewsZod(rootDir: string, scan?: AppScan): Promise<ChatViewsZodInspection> {
  const root = resolve(rootDir);
  const files = (scan ?? await scanApp(root)).files;
  const definitions = files.filter((file) => !TEST_FILE.test(file.path)
    && file.glirastesImports.length > 0 && file.text.includes('defineChatComponent'));
  const chatViews = definitions.length > 0 || existsSync(join(root, TOOLS_PATHS.chatComponents));
  if (!chatViews) return { chatViews, status: 'unknown' };
  const version = await installedVersion(root, 'zod');
  const [major, minor] = (version ?? '').split('.').map((part) => Number.parseInt(part, 10));
  if (major === undefined || Number.isNaN(major)) return { chatViews, status: 'unknown' };
  if (major >= 4) return { chatViews, status: 'pass' };
  if (major < 3 || (minor ?? 0) < 25) return { chatViews, status: 'zod-too-old' };
  const classic = definitions.some((file) => (file.specifiers ?? []).some(({ spec }) => spec === 'zod'));
  return { chatViews, status: classic ? 'classic-import' : 'pass' };
}
