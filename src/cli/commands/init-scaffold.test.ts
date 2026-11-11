import { chmod, lstat, readFile, readlink, stat, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../codegen/tools/__tests__/app-fixture.js';
import { ToolsConfigSchema } from '../../codegen/tools/config.js';
import { LocalPromptBundleSchema } from './validate-build.js';
import { AGENT_HINT_START, scaffoldToolsInputs } from './init-scaffold.js';
import { runToolsPipeline } from '../../codegen/tools/pipeline.js';
import { runToolsCommand } from './tools/index.js';

afterEach(removeAppFixtures);

const APP_ID = '019fb007-0000-7000-8000-0000000000f1';
const OTHER_ID = '019fb007-0000-7000-8000-0000000000f2';
const NEXT_PACKAGE = `${JSON.stringify({ name: '@acme/Task Board', private: true, type: 'module', dependencies: { next: '16', nuqs: '2' } }, null, 2)}\n`;
const ROUTE = 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET() { await getSession(); return Response.json({ tasks: [] as string[] }); }\n';

async function freshApp(files: Record<string, string> = {}) {
  return createAppFixture({ 'package.json': NEXT_PACKAGE, 'src/app/api/tasks/route.ts': ROUTE, ...files },
    { withoutToolsConfig: true, withoutPromptBundle: true });
}

describe('glirastes init scaffold', () => {
  it('writes the tools inputs, scripts and agent hint a fresh Next app needs for its first refresh', async () => {
    const app = await freshApp();
    const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
    expect(scaffold).toEqual({
      appId: APP_ID,
      written: ['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json'],
      notes: ['Set "locale" in .glirastes/tools.json to the language of the app (e.g. "de-DE").'],
    });
    expect(ToolsConfigSchema.parse(JSON.parse(await app.read('.glirastes/tools.json')))).toMatchObject({
      appId: APP_ID, targetAppKey: 'task-board', locale: 'en', sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'],
    });
    expect(LocalPromptBundleSchema.parse(JSON.parse(await app.read('.glirastes/prompt-bundle.json'))).appId).toBe(APP_ID);
    expect(JSON.parse(await app.read('package.json')).scripts).toEqual({
      predev: 'glirastes tools refresh --keep-going', prebuild: 'glirastes tools refresh',
    });
    expect(await app.read('AGENTS.md')).toContain('run `glirastes tools refresh`');
    const out: string[] = [];
    const deps = { cwd: app.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
    expect(await scaffoldToolsInputs({ root: app.root, host: 'codex' })).toEqual({ appId: APP_ID, written: [], notes: [] });
  }, 120_000);

  it('keeps the app id the local files already name and refuses two different ones', async () => {
    const app = await freshApp({ '.glirastes/prompt-bundle.json': JSON.stringify({ schemaVersion: 1, appId: APP_ID }) });
    const kept = await scaffoldToolsInputs({ root: app.root, host: 'claude', createAppId: () => OTHER_ID });
    expect(kept.appId).toBe(APP_ID);
    expect(kept.written).toEqual(['.glirastes/tools.json', 'CLAUDE.md', 'package.json']);
    const conflicted = await freshApp({
      '.glirastes/prompt-bundle.json': JSON.stringify({ schemaVersion: 1, appId: APP_ID }),
      '.glirastes/setup-receipt.json': JSON.stringify({ schemaVersion: 1, appId: OTHER_ID }),
    });
    await expect(scaffoldToolsInputs({ root: conflicted.root, host: 'codex' })).rejects.toMatchObject({ code: 'E-SETUP-021' });
    await expect(conflicted.read('.glirastes/tools.json')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('never replaces existing scripts or instructions and follows an instruction link once', async () => {
    const app = await freshApp({
      'package.json': `${JSON.stringify({ name: 'board', dependencies: { next: '16' }, scripts: { prebuild: 'tsc -p .' } }, null, 4)}\n`,
      'AGENTS.md': '# Agents\n\nUse bun.\n',
    });
    await symlink('AGENTS.md', app.path('CLAUDE.md'), 'file');
    const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'claude', createAppId: () => APP_ID });
    expect(scaffold.written).toEqual(['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json']);
    expect(scaffold.notes).toContain('package.json already has a prebuild script; add "glirastes tools refresh" to it.');
    const packageRaw = await app.read('package.json');
    expect(packageRaw).toContain('\n    "scripts": {');
    expect(JSON.parse(packageRaw).scripts).toEqual({ prebuild: 'tsc -p .', predev: 'glirastes tools refresh --keep-going' });
    const agents = await readFile(app.path('AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\n\nUse bun.\n\n<!-- glirastes:tools -->')).toBe(true);
    expect(agents.split(AGENT_HINT_START)).toHaveLength(2);
    expect((await lstat(app.path('CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(app.path('CLAUDE.md'))).toBe('AGENTS.md');
  }, 60_000);

  it('writes only the prompt bundle and the hint for another stack, and nothing in a dry run', async () => {
    const vite = await createAppFixture({ 'package.json': JSON.stringify({ name: 'vue-board', dependencies: { vue: '3' } }) },
      { withoutToolsConfig: true, withoutPromptBundle: true });
    const preview = await scaffoldToolsInputs({ root: vite.root, host: 'codex', dryRun: true, createAppId: () => APP_ID });
    expect(preview.written).toEqual(['.glirastes/prompt-bundle.json', 'AGENTS.md', 'package.json']);
    expect(preview.notes).toEqual(['No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.']);
    await expect(vite.read('.glirastes/prompt-bundle.json')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(vite.read('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it.skipIf(process.platform === 'win32')('keeps the permissions of the developer\'s package.json and instruction file', async () => {
    const app = await freshApp({ 'AGENTS.md': '# Agents\n' });
    await chmod(app.path('package.json'), 0o644);
    await chmod(app.path('AGENTS.md'), 0o664);
    const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
    expect(scaffold.written).toEqual(['.glirastes/prompt-bundle.json', '.glirastes/tools.json', 'AGENTS.md', 'package.json']);
    expect((await stat(app.path('package.json'))).mode & 0o777).toBe(0o644);
    expect((await stat(app.path('AGENTS.md'))).mode & 0o777).toBe(0o664);
  }, 60_000);

  describe('at a monorepo root', () => {
    const ROOT_PACKAGE = JSON.stringify({ name: 'platform', private: true, workspaces: ['apps/*', 'packages/*'] });
    const CONTROLLER = "import { Controller, Get } from '@nestjs/common';\n"
      + "@Controller('members')\nexport class MembersController {\n  @Get()\n  list() {\n    return [];\n  }\n}\n";
    const monorepo = (files: Record<string, string> = {}) => createAppFixture({
      'package.json': ROOT_PACKAGE,
      'apps/api/package.json': JSON.stringify({ name: '@platform/api', dependencies: { '@nestjs/core': '11', '@nestjs/common': '11' } }),
      'apps/api/src/tasks.controller.ts': CONTROLLER,
      'apps/citadel/package.json': JSON.stringify({ name: '@platform/citadel', dependencies: { next: '15', nuqs: '2' } }),
      'apps/citadel/src/app/api/tasks/route.ts': ROUTE,
      'apps/citadel/src/app/page.tsx': 'export default function Page() { return null; }\n',
      'packages/db/package.json': JSON.stringify({ name: '@platform/db' }),
      ...files,
    }, { withoutToolsConfig: true, withoutPromptBundle: true });

    it('writes one source per workspace app with root-relative paths and says which', async () => {
      const app = await monorepo();
      const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
      const config = ToolsConfigSchema.parse(JSON.parse(await app.read('.glirastes/tools.json')));
      expect(config.sources).toEqual([
        { kind: 'nest', srcDir: 'apps/api/src' },
        { kind: 'next-app', apiDir: 'apps/citadel/src/app/api' },
        { kind: 'next-pages', appDir: 'apps/citadel/src/app', srcDir: 'apps/citadel/src' },
        { kind: 'url-filters', appDir: 'apps/citadel/src/app', srcDir: 'apps/citadel/src' },
        { kind: 'react-actions', srcDir: 'apps/citadel/src' },
      ]);
      expect(scaffold.written).toContain('.glirastes/tools.json');
      expect(scaffold.notes.join('\n')).toContain('nest apps/api/src');
      expect(scaffold.notes.join('\n')).toContain('next-app apps/citadel/src/app/api');
    }, 60_000);

    it('writes a configuration that refresh reads for the nest app', async () => {
      const app = await monorepo();
      await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
      const result = await runToolsPipeline({ root: app.root, mode: 'write', keepGoing: true });
      expect(result.tools.map((tool) => tool.stableKey)).toContain('GET /members');
    }, 60_000);

    it('never writes a path outside the root', async () => {
      const app = await monorepo({ 'package.json': JSON.stringify({ name: 'platform', workspaces: ['../outside/*', '/abs/*', 'apps/*'] }) });
      await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
      const raw = await app.read('.glirastes/tools.json');
      expect(raw).not.toContain('..');
      expect(raw).toContain('apps/api/src');
    }, 60_000);

    it('names the skill in one line when the workspaces hold no supported app', async () => {
      const app = await createAppFixture({
        'package.json': ROOT_PACKAGE, 'packages/db/package.json': JSON.stringify({ name: '@platform/db' }),
      }, { withoutToolsConfig: true, withoutPromptBundle: true });
      const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
      expect(scaffold.written).not.toContain('.glirastes/tools.json');
      expect(scaffold.notes).toEqual([expect.stringMatching(/No supported app.*workspaces.*integrating-glirastes-web/)]);
    }, 60_000);

    it('leaves a root without workspaces as before', async () => {
      const app = await createAppFixture({
        'package.json': JSON.stringify({ name: 'plain' }),
        'apps/api/package.json': JSON.stringify({ dependencies: { '@nestjs/core': '11' } }),
        'apps/api/src/tasks.controller.ts': CONTROLLER,
      }, { withoutToolsConfig: true, withoutPromptBundle: true });
      const scaffold = await scaffoldToolsInputs({ root: app.root, host: 'codex', createAppId: () => APP_ID });
      expect(scaffold.written).not.toContain('.glirastes/tools.json');
      expect(scaffold.notes).toEqual(['No Next.js app: integrating-glirastes-web describes .glirastes/tools.json for this stack.']);
    }, 60_000);
  });
});
