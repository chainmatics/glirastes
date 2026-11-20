import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SDK_VERSION } from '../../runtime/sdk-version.js';
import { readBaseline } from './upgrade/baseline.js';
import { installSkills } from './install-skills.js';
import {
  MANIFEST_RELATIVE_PATH,
  classifyInstalledSkill,
  readInstalledSkillsManifest,
} from './installed-skills-manifest.js';

const packageRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const foundationSkills = [
  'integrating-glirastes-nextjs',
  'maintaining-glirastes-tools',
  'describing-glirastes-tools',
  'building-glirastes-chat-ui',
  'curating-glirastes-chat-interactions',
  'upgrading-glirastes',
] as const;
const setupSkill = 'setting-up-glirastes';

/** A temp project that looks like a Next.js app, so the stack is detectable. */
async function nextAppRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-install-'));
  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { next: '^16.0.0' } }),
    'utf8',
  );
  return rootDir;
}

async function skillSource(name: string): Promise<string> {
  return readFile(join(packageRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('foundation agent skills', () => {
  it.each(foundationSkills)(
    '%s uses portable frontmatter and a trigger-only description',
    async (name) => {
      const source = await skillSource(name);
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';

      expect(frontmatter.split('\n').map((line) => line.split(':')[0]))
        .toEqual(['name', 'description']);
      expect(frontmatter).toContain('description: Use when');
    },
  );

  it('teaches source-derived local generation and optional sync instead of hand-authored annotations', async () => {
    const sources = await Promise.all([
      skillSource('integrating-glirastes-nextjs'),
      skillSource('maintaining-glirastes-tools'),
    ]);
    const combined = sources.join('\n');

    expect(combined).toContain('source-derived generator');
    expect(combined).toContain('glirastes sync');
    expect(combined).toContain('resolvePrincipal');
    expect(combined).not.toMatch(/ai-tool\.ts|@AiTool|@AiModule|@AiParam/);
  });

  it('keeps STT local and uses the single-stream controller', async () => {
    const source = await skillSource('building-glirastes-chat-ui');

    expect(source).toContain('visible interim transcript');
    expect(source).toContain('one microphone stream');
    expect(source).toContain('edit before sending');
    expect(source).not.toContain('LangGraphAiChat');
    expect(source).not.toMatch(/\bTTS\b|duplex voice/i);
  });

  it('documents commands, mentions, clarification, renderers, embedding and push-to-talk', async () => {
    const source = await skillSource('building-glirastes-chat-ui');

    for (const surface of [
      'completionProviders',
      'createUiToolCommandProvider',
      'completionContext',
      'ClarificationCard',
      'clarification',
      'toolRenderers',
      'defineToolResultRenderer',
      'glirastes/embed',
      'defineGlirastesChatElement',
      '--glirastes-chat-',
      'pushToTalk',
      'routeKey',
    ]) {
      expect(source).toContain(surface);
    }
    expect(source).toContain('only hides entries');
    expect(source).toContain('no automatic send on finalization');
  });

  it('installs portable generic integration guidance for a non-Node project with no package.json', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-non-node-install-'));
    try {
      await writeFile(join(rootDir, 'Cargo.toml'), '[package]\nname = "customer-api"\nversion = "1.0.0"\n');
      await installSkills({ rootDir, host: 'codex', quiet: true, includeSetupSkills: true });
      const target = join(rootDir, '.agents/skills');
      expect(await readdir(target)).toContain('integrating-glirastes-web');
      expect(await readdir(target)).not.toContain('integrating-glirastes-nextjs');
      expect(await readFile(join(target, 'integrating-glirastes-web/references/runtime-container.md'), 'utf8')).toContain('glirastes-runtime build');
      expect(await readFile(join(target, 'setting-up-glirastes/references/runtime-hosts.md'), 'utf8')).toContain('no Node server code');
      await expect(access(join(rootDir, 'package.json'))).rejects.toThrow();
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it('does not add generic framework skills when the non-Node developer selected only chat UI', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-ui-only-install-'));
    try {
      await installSkills({ rootDir, host: 'codex', quiet: true, parts: ['chat-ui'] });
      expect(await readdir(join(rootDir, '.agents/skills'))).not.toContain('integrating-glirastes-web');
      expect(await readFile(join(rootDir, '.agents/skills/building-glirastes-chat-ui/references/non-react-hosts.md'), 'utf8')).toContain('config.session');
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it('installs only foundation-supported skills for the all profile', async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      await installSkills({
        parts: ['framework', 'tools', 'chat-ui'],
        dryRun: true,
        rootDir: packageRoot,
        target: '.tmp-skills',
      });
    } finally {
      console.log = originalLog;
    }

    const report = output.join('\n');
    for (const skill of foundationSkills) {
      expect(report).toContain(skill);
    }
    expect(report).not.toContain('integrating-glirastes-nestjs');
    expect(report).not.toContain(
      'integrating-glirastes-nextjs-with-nestjs-backend',
    );
  });

  it('keeps one canonical setup workflow for autonomous and interview mode', async () => {
    const source = await skillSource(setupSkill);

    expect(source).toContain('Autonomous mode');
    expect(source).toContain('Interview mode');
    expect(source).toContain('glirastes tools refresh');
    expect(source).not.toContain('glirastes setup scan');
    expect(source).toContain('glirastes sync');
    expect(source).toContain('Standalone');
    expect(source).toContain('OpenRouter');
    expect(source).toContain('explicit consent');
    expect(source).toContain('Never send');
    expect(source).toContain('Never add decorators');
    expect(source).not.toMatch(/Create an @AiTool|Add @AiModule/);
  });

  it.each([
    ['codex', '.agents/skills'],
    ['claude', '.claude/skills'],
    ['gemini', '.gemini/skills'],
  ] as const)(
    'installs the optional setup skill for the %s host',
    async (host, expectedTarget) => {
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => output.push(values.join(' '));
      try {
        await installSkills({
          parts: ['framework', 'tools', 'chat-ui'],
          includeSetupSkills: true,
          host,
          dryRun: true,
          rootDir: packageRoot,
        });
      } finally {
        console.log = originalLog;
      }

      const report = output.join('\n');
      expect(report).toContain(expectedTarget);
      expect(report).toContain(setupSkill);
      expect(report).toContain(`Hosts:`);
      expect(report).toContain(host);
    },
  );

  it('requires an explicit host when setup skills are accepted', async () => {
    await expect(installSkills({
      parts: ['tools'],
      includeSetupSkills: true,
      dryRun: true,
      rootDir: packageRoot,
    })).rejects.toThrow('Choose at least one setup host');
  });

  it('keeps dry-run side-effect free', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-skills-dry-run-'));
    const target = 'agent-skills';
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        parts: ['tools'],
        includeSetupSkills: true,
        host: 'codex',
        dryRun: true,
        rootDir,
        target,
      });
    } finally {
      console.log = originalLog;
    }

    await expect(access(join(rootDir, target))).rejects.toThrow();
  });

  it('includes canonical skills in the published package allowlist', async () => {
    const packageJson = JSON.parse(await readFile(
      join(packageRoot, 'package.json'),
      'utf8',
    )) as { files?: string[] };

    expect(packageJson.files).toContain('skills');
    expect(packageJson.files).not.toContain('!dist/cli/commands');
  });

  it('names only React surfaces that actually exist in the chat UI skill', async () => {
    const skill = await skillSource('building-glirastes-chat-ui');
    const named = new Set(
      [...skill.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)]
        .map((match) => match[1]!)
        .filter((name) => /^(use[A-Z]|[A-Z])/.test(name)),
    );
    expect(named.size).toBeGreaterThan(20);

    async function readTree(dir: string): Promise<string> {
      const entries = await readdir(dir, { withFileTypes: true });
      const parts = await Promise.all(entries.map(async (entry) => {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) return readTree(absolute);
        if (/\.tsx?$/.test(entry.name)) return readFile(absolute, 'utf8');
        return '';
      }));
      return parts.join('\n');
    }

    const surface = await readTree(join(packageRoot, 'src/react'));
    const missing = [...named].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(surface),
    );

    // A skill that names an export nobody ships sends the reader looking for
    // something that was renamed or never existed.
    expect(missing).toEqual([]);
  });

  it('names only React and server surfaces that exist in the curating skill', async () => {
    const skill = await skillSource('curating-glirastes-chat-interactions');
    const named = [...new Set(
      [...skill.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)]
        .map((match) => match[1]!)
        .filter((name) => /^(use[A-Z]|[A-Z])/.test(name)),
    )];
    expect(named.length).toBeGreaterThan(2);
    async function readTree(dir: string): Promise<string> {
      const entries = await readdir(dir, { withFileTypes: true });
      const parts = await Promise.all(entries.map(async (entry) => {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) return readTree(absolute);
        return /\.tsx?$/.test(entry.name) ? readFile(absolute, 'utf8') : '';
      }));
      return parts.join('\n');
    }
    const surface = `${await readTree(join(packageRoot, 'src/react'))}\n${await readTree(join(packageRoot, 'src/server'))}`;
    expect(named.filter((name) => !new RegExp(`\\b${name}\\b`).test(surface))).toEqual([]);
  });

  it('records what it installed so a refresh can tell it from authored work', async () => {
    const rootDir = await nextAppRoot();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        parts: ['framework', 'tools', 'chat-ui'],
      });
    } finally {
      console.log = originalLog;
    }

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(manifest).not.toBeNull();
    expect(manifest?.installs).toHaveLength(1);
    expect(manifest?.installs[0]?.host).toBe('claude');
    expect(manifest?.installs[0]?.target).toBe('.claude/skills');
    expect(manifest?.installs[0]?.mode).toBe('copy');
    expect(Object.keys(manifest?.installs[0]?.skills ?? {}).sort())
      .toEqual([...foundationSkills].sort());

    for (const name of foundationSkills) {
      expect(await classifyInstalledSkill(rootDir, manifest, 'claude', name))
        .toBe('unchanged');
    }
    expect(await classifyInstalledSkill(rootDir, manifest, 'claude', setupSkill))
      .toBe('unmanaged');
  });

  it('reports an edited skill as modified rather than silently replacing it', async () => {
    const rootDir = await nextAppRoot();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        parts: ['framework', 'tools', 'chat-ui'],
      });
    } finally {
      console.log = originalLog;
    }

    await writeFile(
      join(rootDir, '.claude/skills/maintaining-glirastes-tools/SKILL.md'),
      'the operator rewrote this\n',
      'utf8',
    );

    const manifest = await readInstalledSkillsManifest(rootDir);
    expect(
      await classifyInstalledSkill(rootDir, manifest, 'claude', 'maintaining-glirastes-tools'),
    ).toBe('modified');
    expect(
      await classifyInstalledSkill(rootDir, manifest, 'claude', 'integrating-glirastes-nextjs'),
    ).toBe('unchanged');
  });

  it('writes no manifest on a dry run', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-install-'));
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installSkills({
        rootDir,
        host: 'claude',
        dryRun: true,
      });
    } finally {
      console.log = originalLog;
    }

    await expect(access(join(rootDir, MANIFEST_RELATIVE_PATH)))
      .rejects.toThrow();
  });

  it('ships no skill directory without a described SKILL.md', async () => {
    const skillsDir = join(packageRoot, 'skills');
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories.length).toBeGreaterThan(0);

    const described = await Promise.all(directories.map(async (name) => {
      const source = await readFile(
        join(skillsDir, name, 'SKILL.md'),
        'utf8',
      ).catch(() => '');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
      const hasField = (field: string): boolean =>
        new RegExp(`^${field}:\\s*\\S`, 'm').test(frontmatter);
      return {
        name,
        described: hasField('name') && hasField('description'),
      };
    }));

    expect(described.filter((entry) => !entry.described).map((e) => e.name))
      .toEqual([]);
  });
});

describe('upgrade baseline and hook on install', () => {
  it('fresh install writes baseline at SDK_VERSION', async () => {
    const rootDir = await nextAppRoot();
    await installSkills({ rootDir, host: 'claude', quiet: true });
    expect((await readBaseline(rootDir))!.reviewedThrough).toBe(SDK_VERSION);
  });

  it('brings an outdated Glirastes block in AGENTS.md and CLAUDE.md up to date', async () => {
    const rootDir = await nextAppRoot();
    const old = '<!-- glirastes:tools -->\n## Glirastes tools\n\nOld text.\n<!-- /glirastes:tools -->';
    await writeFile(join(rootDir, 'AGENTS.md'), `# Mine\n\n${old}\n`);
    await writeFile(join(rootDir, 'CLAUDE.md'), '# No block here\n');
    await installSkills({ rootDir, host: 'claude', quiet: true });
    const agents = await readFile(join(rootDir, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Mine\n\n')).toBe(true);
    expect(agents).not.toContain('Old text.');
    expect(agents).toContain('glirastes upgrade report');
    expect(await readFile(join(rootDir, 'CLAUDE.md'), 'utf8')).toBe('# No block here\n');
  });

  it('leaves the Glirastes block alone on a dry run and a global install', async () => {
    const rootDir = await nextAppRoot();
    const old = '<!-- glirastes:tools -->\nOld text.\n<!-- /glirastes:tools -->\n';
    await writeFile(join(rootDir, 'AGENTS.md'), old);
    await installSkills({ rootDir, host: 'claude', quiet: true, dryRun: true });
    await installSkills({ rootDir, host: 'claude', quiet: true, global: true, dryRun: true });
    expect(await readFile(join(rootDir, 'AGENTS.md'), 'utf8')).toBe(old);
  });

  it('writes no baseline on a dry run', async () => {
    const rootDir = await nextAppRoot();
    await installSkills({ rootDir, host: 'claude', quiet: true, dryRun: true });
    expect(await readBaseline(rootDir)).toBeUndefined();
  });

  it('--with-upgrade-hook writes a SessionStart hook running "glirastes upgrade report --brief" into .claude/settings.json and keeps existing hooks', async () => {
    const rootDir = await nextAppRoot();
    await mkdir(join(rootDir, '.claude'), { recursive: true });
    const existing = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
      },
    };
    await writeFile(join(rootDir, '.claude/settings.json'), JSON.stringify(existing));

    await installSkills({ rootDir, host: 'claude', quiet: true, withUpgradeHook: true });
    await installSkills({ rootDir, host: 'claude', quiet: true, withUpgradeHook: true, force: true });

    const settings = JSON.parse(await readFile(join(rootDir, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(settings.hooks.SessionStart).toEqual([
      ...existing.hooks.SessionStart,
      { hooks: [{ type: 'command', command: 'npx --no-install glirastes upgrade report --brief' }] },
    ]);
  });

  it('creates the settings file when there is none', async () => {
    const rootDir = await nextAppRoot();
    await installSkills({ rootDir, host: 'claude', quiet: true, withUpgradeHook: true });
    expect(JSON.parse(await readFile(join(rootDir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx --no-install glirastes upgrade report --brief' }] }] },
    });
  });

  it('without the flag no settings file is touched', async () => {
    const rootDir = await nextAppRoot();
    await installSkills({ rootDir, host: 'claude', quiet: true });
    await expect(access(join(rootDir, '.claude/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(rootDir, '.claude'), { recursive: true });
    await writeFile(join(rootDir, '.claude/settings.json'), '{"a":1}');
    await installSkills({ rootDir, host: 'claude', quiet: true, force: true });
    expect(await readFile(join(rootDir, '.claude/settings.json'), 'utf8')).toBe('{"a":1}');
  });

  it('never overwrites an invalid settings file and still installs', async () => {
    const rootDir = await nextAppRoot();
    await mkdir(join(rootDir, '.claude'), { recursive: true });
    await writeFile(join(rootDir, '.claude/settings.json'), '{ not json');
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)); });
    try {
      await installSkills({ rootDir, host: 'claude', quiet: true, withUpgradeHook: true });
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(join(rootDir, '.claude/settings.json'), 'utf8')).toBe('{ not json');
    expect(errors.join('\n')).toContain('.claude/settings.json is not valid JSON');
    expect(await readInstalledSkillsManifest(rootDir)).not.toBeNull();
  });

  it('refuses a settings file whose hooks have the wrong shape', async () => {
    for (const bad of [{ hooks: [] }, { hooks: { SessionStart: {} } }]) {
      const rootDir = await nextAppRoot();
      await mkdir(join(rootDir, '.claude'), { recursive: true });
      const raw = JSON.stringify(bad);
      await writeFile(join(rootDir, '.claude/settings.json'), raw);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await installSkills({ rootDir, host: 'claude', quiet: true, withUpgradeHook: true });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await readFile(join(rootDir, '.claude/settings.json'), 'utf8')).toBe(raw);
    }
  });

  it('adds no project hook for another host or a global install', async () => {
    const rootDir = await nextAppRoot();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await installSkills({ rootDir, host: 'codex', quiet: true, withUpgradeHook: true });
      expect(String(spy.mock.calls[0]?.[0])).toContain('--with-upgrade-hook');
    } finally {
      spy.mockRestore();
    }
    await expect(access(join(rootDir, '.claude/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('seeds the baseline from a prerelease manifest version', async () => {
    const rootDir = await nextAppRoot();
    await mkdir(join(rootDir, '.glirastes'), { recursive: true });
    await writeFile(
      join(rootDir, '.glirastes/installed-skills.json'),
      JSON.stringify({ schemaVersion: 1, sdkVersion: '0.19.0-rc.1', installs: [] }),
    );
    await installSkills({ rootDir, host: 'claude', quiet: true });
    expect((await readBaseline(rootDir))!.reviewedThrough).toBe('0.19.0-rc.1');
  });

  it('an invalid manifest version warns and writes no baseline', async () => {
    const rootDir = await nextAppRoot();
    await mkdir(join(rootDir, '.glirastes'), { recursive: true });
    await writeFile(
      join(rootDir, '.glirastes/installed-skills.json'),
      JSON.stringify({ schemaVersion: 1, sdkVersion: 'workspace:*', installs: [] }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await installSkills({ rootDir, host: 'claude', quiet: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('workspace:*');
    } finally {
      spy.mockRestore();
    }
    expect(await readBaseline(rootDir)).toBeUndefined();
  });

  it('a corrupt baseline warns once and does not abort the other hosts', async () => {
    const rootDir = await nextAppRoot();
    await mkdir(join(rootDir, '.glirastes'), { recursive: true });
    await writeFile(join(rootDir, '.glirastes/sdk-baseline.json'), '<<<<<<< HEAD\n');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await installSkills({ rootDir, hosts: ['claude', 'codex'], quiet: true });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect((await readInstalledSkillsManifest(rootDir))!.installs.map((install) => install.host).sort()).toEqual(['claude', 'codex']);
  });
});
