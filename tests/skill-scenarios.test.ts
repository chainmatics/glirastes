import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, SDK_ROOT, type AppFixture } from '../src/codegen/tools/__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../src/codegen/tools/config.js';
import { ToolContractsFileSchema } from '../src/codegen/tools/files.js';
import type { DescribeWorklist, ResolveWorklist } from '../src/codegen/tools/worklist.js';
import { readSkill, skillCommands } from '../src/cli/commands/__tests__/skill-lint.js';
import { scaffoldToolsInputs } from '../src/cli/commands/init-scaffold.js';
import { runToolsCommand } from '../src/cli/commands/tools/index.js';
import type { ToolsWatchFactory } from '../src/cli/commands/tools/watch.js';

/**
 * Every shipped skill runs the `glirastes tools` lines of its Commands block
 * against a fixture, with prepared agent and developer answers in between
 * (spec 4.12 "Skills": no model). A skill that teaches a command its scenario
 * does not run fails here, so the skills and the CLI cannot drift apart.
 */
afterEach(removeAppFixtures);

interface Run {
  code: number;
  out: string;
  err: string;
}

interface Scenario {
  /** Runs one line of the skill's Commands block; `<…>` placeholders are filled from `values`. */
  run(line: string, values?: Record<string, string>): Promise<Run>;
  json<T>(line: string, values?: Record<string, string>): Promise<T>;
}

async function scenario(skill: string, fixture: AppFixture, steps: (s: Scenario) => Promise<void>, extra: {
  watch?: ToolsWatchFactory;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const commands = skillCommands(await readSkill(skill)).map((command) => command.line);
  const executed = new Set<string>();
  const run = async (line: string, values: Record<string, string> = {}): Promise<Run> => {
    expect(commands, `${skill} teaches ${line}`).toContain(line);
    executed.add(line);
    const filled = line.replace(/<([a-z-]+)>/g, (placeholder, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`No value for ${placeholder} in ${line}`);
      return value;
    });
    const argv = (filled.match(/"([^"]*)"|(\S+)/g) ?? []).map((word) => word.replace(/^"|"$/g, ''));
    expect(argv.slice(0, 2)).toEqual(['glirastes', 'tools']);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runToolsCommand(argv.slice(2), {
      cwd: fixture.root,
      env: {},
      log: (text) => { out.push(text); },
      error: (text) => { err.push(text); },
      ...extra,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  await steps({
    run,
    async json<T>(line: string, values?: Record<string, string>) {
      const result = await run(line, values);
      expect(result.code).toBe(0);
      return JSON.parse(result.out) as T;
    },
  });
  const toolsLines = commands.filter((line) => line.startsWith('glirastes tools '));
  expect(toolsLines.filter((line) => !executed.has(line)), `${skill} commands without a scenario step`).toEqual([]);
}

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n";
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['src/*'] } } });
const TASKS_ROUTE = "import { getSession } from '@/lib/session';\n"
  + 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
  + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }, { status: 201 });\n}\n';
const BRIDGE = "'use client';\nimport { useRouter } from 'next/navigation';\nimport { useGlirastesNavigationBridge } from 'glirastes/react';\n"
  + 'export function GlirastesNavigationBridge() {\n  const router = useRouter();\n'
  + '  useGlirastesNavigationBridge({ push: (href) => router.push(href) });\n  return null;\n}\n';
const TASKS_PAGE = "'use client';\nimport { parseAsStringLiteral, useQueryState } from 'nuqs';\nimport { z } from 'zod';\n"
  + "import { useAiClientAction } from 'glirastes/react';\n"
  + 'export default function TasksPage() {\n'
  + "  const [status] = useQueryState('status', parseAsStringLiteral(['open', 'done']));\n"
  + "  useAiClientAction('tasks.highlight', (payload) => console.log(payload.taskId), z.object({ taskId: z.string() }).strict());\n"
  + '  return status;\n}\n';

function nextApp(files: Record<string, string> = {}, toolsConfig: Record<string, unknown> = {}): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': TSCONFIG,
    'src/lib/session.ts': SESSION,
    'src/app/api/tasks/route.ts': TASKS_ROUTE,
    ...files,
  }, { toolsConfig });
}

async function interfaceOf(fixture: AppFixture, stableKey: string): Promise<string> {
  const contracts = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts)));
  return contracts.tools.find((entry) => entry.stableKey === stableKey)!.contract!.interfaceDigest;
}

/** The first fenced block of a language in a skill, without its list indentation. */
async function codeBlock(skill: string, language: string): Promise<string> {
  const source = await readSkill(skill);
  const match = new RegExp(`^( *)\`\`\`${language}\\n([\\s\\S]*?)^\\1\`\`\``, 'm').exec(source);
  if (!match) throw new Error(`${skill} has no ${language} block`);
  const indent = match[1]!.length;
  return match[2]!.split('\n').map((line) => line.slice(indent)).join('\n');
}

describe('skill scenarios', () => {
  it('setting-up-glirastes takes a fresh Next app from init to a checked first tool', async () => {
    const fixture = await createAppFixture({
      'package.json': `${JSON.stringify({ name: 'board', private: true, type: 'module', dependencies: { next: '16' } })}\n`,
      'src/lib/session.ts': SESSION,
      'tsconfig.json': TSCONFIG,
      'src/app/api/tasks/route.ts': TASKS_ROUTE,
    }, { withoutToolsConfig: true, withoutPromptBundle: true });
    await scaffoldToolsInputs({ root: fixture.root, host: 'claude' });
    await scenario('setting-up-glirastes', fixture, async (s) => {
      const refresh = await s.run('glirastes tools refresh');
      expect(refresh.code).toBe(0);
      expect(refresh.out).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
      expect(refresh.out).toContain('need a better description – your coding agent can do this with `glirastes tools describe --print`.');
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items.map((item) => item.tool))
        .toEqual(['tasks.create', 'tasks.list']);
      expect((await s.run('glirastes tools eval')).out).toContain('Without example sentences (2)');
      expect((await s.run('glirastes tools status')).out).toContain('What can my chat do? 2 active tools, 0 need attention.');
      const check = await s.json<{ mode: string; driftPaths: string[] }>('glirastes tools check --json');
      expect(check).toMatchObject({ mode: 'frozen', driftPaths: [] });
    });
  }, 240_000);

  it('integrating-glirastes-nextjs derives navigation, filters and actions and its chat route type-checks', async () => {
    const fixture = await nextApp({
      'src/app/layout.tsx': "import { GlirastesNavigationBridge } from '@/components/bridge';\n"
        + 'export default function Layout({ children }: { children: unknown }) { return [GlirastesNavigationBridge(), children]; }\n',
      'src/components/bridge.tsx': BRIDGE,
      'src/app/tasks/page.tsx': TASKS_PAGE,
      'src/lib/glirastes-principal.ts': 'export async function resolvePrincipal(request: Request) {\n'
        + "  return request.headers.get('cookie') ? { subjectId: 'u1', tenantId: '019fb007-0000-7000-8000-000000000002', roles: [], attributes: {} } : undefined;\n}\n",
    }, { sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'] });
    const controller = new AbortController();
    let watched = false;
    const watch: ToolsWatchFactory = () => {
      watched = true;
      queueMicrotask(() => controller.abort());
      return { close: () => undefined };
    };
    await scenario('integrating-glirastes-nextjs', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const watch = await s.run('glirastes tools refresh --watch');
      expect(watch).toMatchObject({ code: 0 });
      expect(watch.out).toContain('Watching the app for tool changes.');
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ ui.navigate  UI glirastes.navigate  safe-read, runs directly');
      expect(status.out).toContain('+ ui.filter.tasks  UI glirastes.navigate');
      expect(status.out).toContain('+ ui.tasks.highlight  UI tasks.highlight');
      expect((await s.run('glirastes tools check')).out).toContain('Tool outputs match the code.');
      expect((await s.run('glirastes tools check --integrity-only')).out).toContain('Tool outputs verified (integrity).');
    }, { watch, signal: controller.signal });
    expect(watched).toBe(true);
    await fixture.write('src/app/api/chat/route.ts', await codeBlock('integrating-glirastes-nextjs', 'ts'));
    const program = ts.createProgram([fixture.path('src/app/api/chat/route.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, baseUrl: fixture.root,
      paths: {
        '@/*': ['src/*'],
        'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
        'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
        'glirastes/server/nextjs': [join(SDK_ROOT, 'src/server/adapters/nextjs/index.ts')],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(fixture.path('src/app/api/chat/route.ts')));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    // The chat route itself is never a tool: refresh reports it as a default exclusion.
    const refreshed: string[] = [];
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: (line) => { refreshed.push(line); }, error: () => undefined })).toBe(0);
    expect(refreshed.join('\n')).toMatch(/\. POST \/api\/chat {2}\S+ \(default\)/);
    expect(refreshed.join('\n')).not.toContain('+ chat.');
  }, 240_000);

  it('integrating-glirastes-web reads the browser registrations of a Vite app', async () => {
    const snippet = await codeBlock('integrating-glirastes-web', 'ts');
    const fixture = await createAppFixture({
      'package.json': `${JSON.stringify({ name: 'vue-board', private: true, type: 'module', dependencies: { vue: '3' } })}\n`,
      'tsconfig.json': TSCONFIG,
      'src/main.ts': 'declare const router: { push(href: string): void };\n'
        + 'declare function highlight(taskId: string): void;\n'
        + snippet,
    }, { toolsConfig: { sources: ['react-actions', 'url-filters'] } });
    await scenario('integrating-glirastes-web', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('What can my chat do? 2 active tools, 0 need attention.');
      expect(status.out).toContain('+ ui.filter.tasks');
      expect(status.out).toContain('+ ui.tasks.highlight');
      expect((await s.run('glirastes tools check')).code).toBe(0);
      expect((await s.run('glirastes tools check --integrity-only')).code).toBe(0);
    });
  }, 240_000);

  it('maintaining-glirastes-tools resolves the stage-1 work list and the developer policy commands apply', async () => {
    const fixture = await nextApp({
      'src/lib/session.ts': `${SESSION}export async function checkMembership(request: Request) {\n  return request.headers.get('x-team') !== null;\n}\n`,
      'src/lib/api.ts': "export async function archiveTask(id: string) {\n  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });\n}\n",
      'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\n"
        + 'declare function save(value: unknown): Promise<{ id: string }>;\n'
        + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
        + '  return Response.json(await save(body));\n}\n',
      'src/app/api/reports/route.ts': "import { checkMembership } from '@/lib/session';\n"
        + 'export async function GET(request: Request) {\n  await checkMembership(request);\n  return Response.json({ reports: [] as string[] });\n}\n',
      'src/components/tasks.tsx': "'use client';\nimport { useAiClientAction } from 'glirastes/react';\nimport { archiveTask } from '@/lib/api';\n"
        + "export function Tasks() {\n  useAiClientAction('tasks.archive', (payload: { taskId: string }) => archiveTask(payload.taskId));\n  return null;\n}\n",
    }, { sources: ['next-app', 'react-actions'] });
    await scenario('maintaining-glirastes-tools', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).out).toContain('2 tools need attention');
      const list = await s.json<ResolveWorklist>('glirastes tools resolve --print');
      expect(list.items.map((item) => [item.code, item.owner])).toEqual([
        ['input-contract-unresolved', 'agent'], ['auth-evidence-missing', 'agent'], ['ui-action-write-unproven', 'developer'],
      ]);
      const notes = list.items[0]!;
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        schemaVersion: 1,
        conventions: { authHelpers: ['checkMembership'] },
        tools: {
          [notes.stableKey]: {
            ...(notes.expected as Record<string, unknown>),
            model: 'claude-code',
            input: { jsonSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, description: 'The note text.' } }, required: ['text'], additionalProperties: false } },
          },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const after = await s.json<ResolveWorklist>('glirastes tools resolve --print');
      expect(after.items.map((item) => item.owner)).toEqual(['developer']);
      // The developer's part, with the commands the skill shows.
      expect((await s.run('glirastes tools policy show <tool>', { tool: 'ui.tasks.archive' })).out).toContain('ui.tasks.archive');
      expect((await s.run('glirastes tools policy raise <tool> write --reason "<why>"', { tool: 'ui.tasks.archive', why: 'archives through the API' })).code).toBe(0);
      expect((await s.run('glirastes tools policy confirm <tool>', { tool: 'reports.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy disable <tool> --reason "<why>"', { tool: 'tasks.list', why: 'not for the chat yet' })).code).toBe(0);
      expect((await s.run('glirastes tools policy relax <tool> --yes --reason "<review>"', { tool: 'notes.create', review: 'reviewed in PR 7' })).code).toBe(0);
      expect((await s.run('glirastes tools policy exclude "POST /api/internal/**" --reason "<why>"', { why: 'internal' })).code).toBe(0);
      expect((await s.run('glirastes tools policy include "POST /api/internal/**"')).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      // A lower risk the code implies is held until the developer accepts it.
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        ...JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)),
        tools: {
          ...JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)).tools,
          'GET /api/reports': { interfaceDigest: await interfaceOf(fixture, 'GET /api/reports'), effect: 'destructive' },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const resolutions = JSON.parse(await fixture.read(TOOLS_PATHS.resolutions)) as { tools: Record<string, unknown> };
      delete resolutions.tools['GET /api/reports'];
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify(resolutions, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).out).toContain('risk-lower-available');
      expect((await s.run('glirastes tools policy accept <tool>', { tool: 'reports.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy reset <tool>', { tool: 'tasks.list' })).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ notes.create  POST /api/notes  write, runs directly');
      expect(status.out).toContain('+ reports.list  GET /api/reports  safe-read, asks first, locked in tool-policy.json');
      expect(status.out).toContain('+ ui.tasks.archive  UI tasks.archive  write, asks first, locked in tool-policy.json');
      expect((await s.run('glirastes tools check')).out).toContain('Tool outputs match the code.');
    });
  }, 300_000);

  it('describing-glirastes-tools fills the stage-2 gaps, routes the examples and locks the review', async () => {
    const fixture = await nextApp({}, { locale: 'de-DE', enrich: { writeContracts: true } });
    await scenario('describing-glirastes-tools', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const list = await s.json<DescribeWorklist>('glirastes tools describe --print');
      expect(list.languages).toEqual(['de', 'en']);
      const byTool = new Map(list.items.map((item) => [item.tool, item] as const));
      const listInterface = byTool.get('tasks.list')!.evidence.interfaceDigest!;
      const createInterface = byTool.get('tasks.create')!.evidence.interfaceDigest!;
      const agent = (interfaceDigest: string) => ({ model: 'claude-code', interfaceDigest });
      await fixture.write(TOOLS_PATHS.semantics, `${JSON.stringify({
        schemaVersion: 1,
        tools: [
          {
            stableKey: 'GET /api/tasks',
            description: 'Listet die Aufgaben des Nutzers, auf Wunsch nach Status gefiltert. Zum Anlegen tasks.create nutzen.',
            synonyms: { de: ['Aufgabenliste', 'offene Aufgaben'], en: ['to-dos', 'task list'] },
            examples: {
              de: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind erledigt?', 'Liste alle Aufgaben'],
              en: ['list my open tasks', 'which tasks are done', 'show the task list'],
            },
            exampleCalls: [{ sentence: 'list my open tasks', input: { status: ['open'] } }],
            origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
            agent: agent(listInterface),
          },
          {
            stableKey: 'POST /api/tasks',
            description: 'Legt eine neue Aufgabe mit Titel an. Zum Auflisten tasks.list nutzen.',
            synonyms: { de: ['Aufgabe anlegen', 'neue Aufgabe'], en: ['add task', 'create task'] },
            examples: {
              de: ['Leg eine neue Aufgabe an', 'Erstelle eine Aufgabe Bericht schreiben', 'Neue Aufgabe anlegen'],
              en: ['add a new task', 'create a task called report', 'create task for the review'],
            },
            approvalHint: 'Fragt vor dem Anlegen nach, weil die Aufgabe für das Team sichtbar wird.',
            origin: { description: 'agent', synonyms: 'agent', examples: 'agent', approvalHint: 'agent' },
            agent: agent(createInterface),
          },
        ],
      }, null, 2)}\n`);
      await fixture.write(TOOLS_PATHS.resolutions, `${JSON.stringify({
        schemaVersion: 1,
        tools: {
          'GET /api/tasks': {
            origin: 'agent', model: 'claude-code', interfaceDigest: listInterface,
            input: { jsonSchema: { type: 'object', properties: { status: { type: 'array', items: { type: 'string', enum: ['open', 'done'] } } }, additionalProperties: false } },
          },
          'POST /api/tasks': {
            origin: 'agent', model: 'claude-code', interfaceDigest: createInterface,
            input: { jsonSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false } },
          },
        },
      }, null, 2)}\n`);
      expect((await s.run('glirastes tools refresh')).out).not.toContain('resolution-rejected');
      expect((await s.run('glirastes tools eval')).out).toContain('Routing check (top 3): 12 of 12 example sentences find their tool.');
      expect((await s.json<{ summary: { failed: number } }>('glirastes tools eval --json')).summary.failed).toBe(0);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items).toEqual([]);
      const named = await s.json<DescribeWorklist>('glirastes tools describe --print <tool>', { tool: 'tasks.list' });
      expect(named.items.map((item) => [item.tool, item.gaps])).toEqual([['tasks.list', ['requested']]]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print --all')).items).toHaveLength(2);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print --write-contracts')).writeContracts).toBe(true);
      expect((await s.run('glirastes tools status')).out).toContain('contract: resolution, description: agent, schema: agent');
      expect((await s.run('glirastes tools verify <tool>', { tool: 'tasks.list' })).code).toBe(0);
    });
    expect((await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined }))).toBe(0);
    const status: string[] = [];
    await runToolsCommand(['status'], { cwd: fixture.root, env: {}, log: (line) => { status.push(line); }, error: () => undefined });
    expect(status.join('\n')).toContain('contract: resolution, description: human, schema: json-schema');
  }, 300_000);

  it('building-glirastes-chat-ui lists the UI tools the chat can run', async () => {
    const fixture = await nextApp({
      'src/components/bridge.tsx': BRIDGE,
      'src/app/tasks/page.tsx': TASKS_PAGE,
    }, { sources: ['next-app', 'next-pages', 'url-filters', 'react-actions'] });
    await scenario('building-glirastes-chat-ui', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      const status = await s.run('glirastes tools status');
      expect(status.out).toContain('+ ui.navigate');
      expect(status.out).toContain('+ ui.tasks.highlight');
    });
  }, 240_000);

  it('migrating-to-glirastes keeps tool ids through --adopt and carries roles and confirmation over', async () => {
    const pilot = await nextApp();
    expect(await runToolsCommand(['refresh'], { cwd: pilot.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const pilotTools = ToolContractsFileSchema.parse(JSON.parse(await pilot.read(TOOLS_PATHS.contracts))).tools
      .map((tool) => [tool.stableKey, tool.toolId]);
    const fixture = await nextApp();
    await cp(pilot.path(TOOLS_PATHS.inventory), fixture.path('pilot/foundation-execution-inventory.json'));
    await scenario('migrating-to-glirastes', fixture, async (s) => {
      expect((await s.run('glirastes tools refresh --adopt <inventory>', { inventory: 'pilot/foundation-execution-inventory.json' })).code).toBe(0);
      const adopted = ToolContractsFileSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.contracts))).tools
        .map((tool) => [tool.stableKey, tool.toolId]);
      expect(adopted).toEqual(pilotTools);
      expect((await s.run('glirastes tools policy roles <tool> <roles>', { tool: 'tasks.create', roles: 'admin,teamleiter' })).code).toBe(0);
      expect((await s.run('glirastes tools policy confirm <tool>', { tool: 'tasks.list' })).code).toBe(0);
      expect((await s.run('glirastes tools policy raise <tool> delete --reason "<why>"', { tool: 'tasks.create', why: 'bulk delete route' })).code).toBe(0);
      expect((await s.run('glirastes tools refresh')).code).toBe(0);
      expect((await s.json<ResolveWorklist>('glirastes tools resolve --print')).items).toEqual([]);
      expect((await s.json<DescribeWorklist>('glirastes tools describe --print')).items).toHaveLength(2);
      const status = await s.json<{ tools: Array<{ name: string; riskClass: string; confirmation: boolean }> }>('glirastes tools status --json');
      expect(status.tools.map((tool) => [tool.name, tool.riskClass, tool.confirmation])).toEqual([
        ['tasks.create', 'delete', true], ['tasks.list', 'safe-read', true],
      ]);
      expect((await s.run('glirastes tools check')).code).toBe(0);
    });
  }, 240_000);
});
