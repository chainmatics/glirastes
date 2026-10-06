import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChatInteractionOverrides } from '../../contracts/chat-interactions.js';
import { findPackageSkillsDir } from './install-skills.js';

describe('bundled local-first setup workflow', () => {
  it('derives tools with refresh and works through the agent work lists before wiring the chat', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/SKILL.md'), 'utf8');
    expect(source).toContain('glirastes setup inspect --json');
    expect(source.indexOf('glirastes tools refresh')).toBeGreaterThan(0);
    expect(source.indexOf('glirastes tools refresh')).toBeLessThan(source.indexOf('glirastes tools resolve --print'));
    expect(source.indexOf('glirastes tools resolve --print')).toBeLessThan(source.indexOf('glirastes tools describe --print'));
    expect(source).toContain('Standalone');
    expect(source).toContain('existing coding agent');
    expect(source).not.toContain('glirastes setup scan');
    expect(source).not.toContain('glirastes setup sync --artifact');
    expect(source).not.toContain('Ask the user to choose exactly one mode');
  });

  it('documents complete local bootstrap artifacts and does not confuse digest metadata with prompt content', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/references/artifact-contract.md'), 'utf8');
    for (const required of ['FoundationExecutionInventorySchema', 'targetAppKey', 'sections', 'appBehavior', 'responseStyle', 'server-verified']) {
      expect(source).toContain(required);
    }
    expect(source).toContain('Preserve');
  });

  it('lists the chat interactions input and the generated module outputs the chat reads', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'setting-up-glirastes/references/artifact-contract.md'), 'utf8');
    const inputs = source.slice(source.indexOf('## Inputs'), source.indexOf('## Outputs'));
    expect(inputs).toContain('`.glirastes/chat-interactions.json`');
    const outputs = source.slice(source.indexOf('## Outputs'), source.indexOf('## Principal'));
    for (const required of ['`chatInteractions`', '`createMcpEndpointCatalog()`', 'emit.mcpCatalog']) {
      expect(outputs).toContain(required);
    }
  });

  it('keeps the Next.js companion local-first with real server authorization', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'integrating-glirastes-nextjs/SKILL.md'), 'utf8');
    for (const required of ['setting-up-glirastes', 'Standalone', 'createLocalRuntimeSource', 'resolvePrincipal', 'navigation', 'filter']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('In the Platform interviewer');
    expect(source).not.toContain('glirastes scan --sync');
    // One object for the POST and the chat interactions GET (the route example type-checks in tests/skill-scenarios.test.ts).
    expect(source).toMatch(/const managedRuntime: ManagedLocalRuntimeConfig = \{/);
    expect(source).toContain('shared `const` at module scope');
  });

  it('keeps the web companion within what the chat handler calls the API with', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'integrating-glirastes-web/SKILL.md'), 'utf8');
    // createAiChatHandler builds its own caller from the chat request (origin and cookie only)
    // and has no option to replace it, see chat-handler-internal-caller.test.ts.
    for (const required of ['same origin', 'session cookie', 'open gap']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('createFetchInternalApiCaller');
    expect(source).not.toContain('defaultHeaders');
    expect(source).not.toContain('cookie or `Authorization` header');
  });

  it('maintains local code changes without making platform sync mandatory', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'maintaining-glirastes-tools/SKILL.md'), 'utf8');
    for (const required of ['Standalone', 'navigation', 'filter', 'glirastes tools resolve --print', 'glirastes tools check', 'glirastes doctor', 'restart']) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('Platform interviewer');
    expect(source).not.toContain('Never duplicate Platform semantics');
    expect(source).not.toContain('Setup/Doctor alone do not currently guarantee this handler check');
  });

  it('uses the drop-in endpoint instead of requesting a second transport', async () => {
    const source = await readFile(join(findPackageSkillsDir(), 'building-glirastes-chat-ui/SKILL.md'), 'utf8');
    expect(source).toContain('creates its transport internally');
    const examples = source.match(/<VercelAiChat\b[^>]*\/>/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(example).toContain('endpoint=');
    expect(source).not.toContain('| `transport` | required;');
    expect(source).not.toContain('| `primary`, `primarySoft` |');
  });

  it('teaches chat entities and commands in the chat UI and the describing skill', async () => {
    const chatUi = await readFile(join(findPackageSkillsDir(), 'building-glirastes-chat-ui/SKILL.md'), 'utf8');
    for (const text of ['docs/chat-interactions.md', 'createChatInteractionsHandler', 'useChatInteractionsData', 'directCommands: false']) {
      expect(chatUi).toContain(text);
    }
    // The skills carry the derivation summary and the keyboard model themselves: docs/ is not in the package.
    for (const text of ['open.<path>', 'filter.<view>', 'ArrowRight', 'Escape', 'not shipped in the package']) {
      expect(chatUi).toContain(text);
    }
    // Only a hand-composed RichMentionInput takes DropdownItem; VercelAiChat and MentionInput do not forward it.
    expect(chatUi).toMatch(/hand-composed\s+`RichMentionInput`/);
    expect(chatUi).not.toMatch(/custom `components\.DropdownItem`/);
    expect(chatUi).toMatch(/`managedRuntime` once as a `const`/);
    const describing = await readFile(join(findPackageSkillsDir(), 'describing-glirastes-tools/SKILL.md'), 'utf8');
    expect(describing).toContain('.glirastes/chat-interactions.json');
    expect(describing).toContain('`hidden` is no permission');
    // A refresh can stop deriving an id: the chat route ignores the patch with a warning, so it is removed, not kept.
    const flat = describing.replace(/\s+/g, ' ');
    for (const text of ['is stale', 'Remove stale patches', 'after every refresh', 'logs one console warning']) {
      expect(flat).toContain(text);
    }
    // The example is a file the chat route accepts.
    const example = /```json\n(\{\n {2}"schemaVersion": 1,\n {2}"commands"[\s\S]*?)```/.exec(describing)?.[1];
    expect(example).toBeDefined();
    expect(() => parseChatInteractionOverrides(JSON.parse(example!))).not.toThrow();
  });
});
