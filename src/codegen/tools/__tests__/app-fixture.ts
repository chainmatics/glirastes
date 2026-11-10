import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURE_APP_ID = '019fb007-0000-7000-8000-0000000000a1';
export const FIXTURE_PROMPT_BUNDLE = {
  schemaVersion: 1,
  appId: FIXTURE_APP_ID,
  artifactRef: 'local://tool-fixture/prompts',
  sections: {
    planner: 'Use the available tools; ask when the target is unclear.',
    appBehavior: 'Help with the fixture app.',
    responseStyle: 'Be concise.',
    capabilityFragments: {},
  },
};

export interface AppFixture {
  root: string;
  path(relativePath: string): string;
  write(relativePath: string, content: string): Promise<void>;
  read(relativePath: string): Promise<string>;
  remove(relativePath: string): Promise<void>;
}

const created: string[] = [];

export async function createAppFixture(
  files: Readonly<Record<string, string>> = {},
  options: {
    toolsConfig?: Readonly<Record<string, unknown>>;
    withoutToolsConfig?: boolean;
    withoutPromptBundle?: boolean;
  } = {},
): Promise<AppFixture> {
  const parent = join(SDK_ROOT, '.tool-fixtures');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'app-'));
  created.push(root);
  const fixture: AppFixture = {
    root,
    path: (relativePath) => join(root, relativePath),
    async write(relativePath, content) {
      await mkdir(dirname(join(root, relativePath)), { recursive: true });
      await writeFile(join(root, relativePath), content, 'utf8');
    },
    read: (relativePath) => readFile(join(root, relativePath), 'utf8'),
    remove: (relativePath) => rm(join(root, relativePath), { recursive: true, force: true }),
  };
  await fixture.write('package.json', `${JSON.stringify({ name: 'tool-fixture', private: true, type: 'module' })}\n`);
  if (!options.withoutToolsConfig) {
    await fixture.write('.glirastes/tools.json', `${JSON.stringify({
      schemaVersion: 1,
      appId: FIXTURE_APP_ID,
      targetAppKey: 'tool-fixture',
      locale: 'en-US',
      sources: ['next-app'],
      ...options.toolsConfig,
    })}\n`);
  }
  if (!options.withoutPromptBundle) {
    await fixture.write('.glirastes/prompt-bundle.json', `${JSON.stringify(FIXTURE_PROMPT_BUNDLE)}\n`);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    await fixture.write(relativePath, content);
  }
  return fixture;
}

export async function removeAppFixtures(): Promise<void> {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
}
