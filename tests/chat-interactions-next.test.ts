import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline, ToolsPipelineFailure } from '../src/codegen/tools/pipeline.js';
import type { ChatInteractionsData } from '../src/contracts/chat-interactions.js';
import { assertBuiltSdk, copyApp, GENERATED_MODULE, NATIVE_APP, removeCopiedApps } from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

export const NOTES_SCHEMAS = "import { z } from 'zod';\n\n"
  + 'export const listNotesInput = z.object({ search: z.string().optional() }).strict();\n'
  + 'export const listNotesOutput = z.object({\n'
  + '  notes: z.array(z.object({ id: z.string(), title: z.string() })),\n'
  + "}).describe('Search your notes by title.');\n"
  + 'export const pinNoteInput = z.object({ id: z.string().min(1) }).strict();\n'
  + "export const pinNoteOutput = z.object({ id: z.string(), pinned: z.boolean() }).describe('Pin one of your notes.');\n";

export const NOTES_ROUTE = "import { listNotesInput, listNotesOutput } from './schemas.js';\n"
  + "import { query } from '../../../query.js';\n\n"
  + "const notes = [{ id: 'n1', title: 'Release notes', owner: 'alice' }, { id: 'n2', title: 'Private', owner: 'bob' }];\n\n"
  + 'export async function GET(request) {\n'
  + '  return query(request, listNotesInput, listNotesOutput, (input, principal) => ({\n'
  + '    notes: notes\n'
  + '      .filter((note) => note.owner === principal.subjectId && (!input.search || note.title.toLowerCase().includes(input.search.toLowerCase())))\n'
  + '      .map(({ id, title }) => ({ id, title })),\n'
  + '  }));\n}\n';

export const PIN_ROUTE = "import { pinNoteInput, pinNoteOutput } from '../../schemas.js';\n"
  + "import { resolveSession } from '../../../../../auth.js';\n\n"
  + 'export async function POST(request, { params }) {\n'
  + '  const principal = resolveSession(request);\n'
  + "  if (!principal) return Response.json({ error: 'Unauthenticated' }, { status: 401 });\n"
  + '  const input = pinNoteInput.safeParse(await params);\n'
  + "  if (!input.success) return Response.json({ error: 'Invalid note' }, { status: 400 });\n"
  + '  return Response.json(pinNoteOutput.parse({ id: input.data.id, pinned: true }));\n}\n';

/** The native fixture plus a searchable notes collection with a pin action. */
export async function addNotes(root: string): Promise<void> {
  await mkdir(join(root, 'src/app/api/notes/[id]/pin'), { recursive: true });
  await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
  await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);
  await writeFile(join(root, 'src/app/api/notes/[id]/pin/route.js'), PIN_ROUTE);
}

async function interactionsOf(root: string): Promise<ChatInteractionsData> {
  const generated = await import(pathToFileURL(join(root, GENERATED_MODULE)).href) as { chatInteractions: ChatInteractionsData };
  return generated.chatInteractions;
}

describe('chat interactions derived from the Next reference app', () => {
  it('turns pages, URL filters and client actions into commands and keeps check and integrity green', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    expect(await interactionsOf(root)).toEqual({
      schemaVersion: 1,
      entities: [],
      commands: [
        {
          id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
          args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
          run: { kind: 'ui', tool: 'ui.filter.tasks' },
        },
        { id: 'open.overview', label: { en: 'Open Overview', de: 'Overview öffnen' }, keywords: ['overview'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
        { id: 'open.tasks', label: { en: 'Open Tasks', de: 'Tasks öffnen' }, keywords: ['tasks'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } },
        {
          id: 'tasks.highlight', label: { en: 'Tasks highlight', de: 'Tasks highlight' },
          args: [{ name: 'title', label: 'Title', required: true }],
          run: { kind: 'ui', tool: 'ui.tasks.highlight' },
        },
      ],
    });
    expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root, mode: 'integrity' })).driftPaths).toEqual([]);
  }, 120_000);

  it('derives a searchable entity and its item action from a new collection route', async () => {
    const root = await copyApp(NATIVE_APP);
    await addNotes(root);
    await runToolsPipeline({ root, mode: 'write' });
    const interactions = await interactionsOf(root);
    expect(interactions.entities).toEqual([{
      type: 'note',
      label: { en: 'Note', de: 'Note' },
      search: { tool: 'notes.list', path: '/api/notes', queryParam: 'search', itemsPath: ['notes'], idField: 'id', labelField: 'title' },
      actions: [{ id: 'note.notesPin.create', label: { en: 'Pin', de: 'Pin' }, entityArg: 'id', run: { kind: 'tool', tool: 'notesPin.create' } }],
    }]);
    expect(interactions.commands.map((command) => command.id)).toEqual(['filter.tasks', 'open.overview', 'open.tasks', 'tasks.highlight']);
  }, 120_000);
});

const MEMBER_PAGE = "'use client';\n"
  + "import { useSearchParams } from 'next/navigation';\n\n"
  + 'export default function MemberPage() {\n'
  + '  const params = useSearchParams();\n'
  + "  return <section data-testid=\"native-ui\"><h1>Member</h1><p>{params.get('status')}</p></section>;\n}\n";

describe('chat interactions of a two-segment dynamic filter page', () => {
  it('renders the same module from the observed contracts and from tool-contracts.json, and the integrity check covers it', async () => {
    const root = await copyApp(NATIVE_APP);
    const pageDir = join(root, 'src/app/(app)/teams/[teamId]/members/[memberId]');
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, 'page.jsx'), MEMBER_PAGE);
    await runToolsPipeline({ root, mode: 'write' });
    const { commands } = await interactionsOf(root);
    expect(commands.find((command) => command.id === 'filter.teamsMembersItem')).toEqual({
      id: 'filter.teamsMembersItem',
      label: { en: 'Filter Teams members item', de: 'Teams members item filtern' },
      args: [
        { name: 'params.memberId', label: 'Member id', required: true },
        { name: 'params.teamId', label: 'Team id', required: true },
        { name: 'status', label: 'Status' },
      ],
      run: { kind: 'ui', tool: 'ui.filter.teamsMembersItem' },
    });
    // `write` renders from the observed contracts, `integrity` from the committed tool-contracts.json.
    expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
    expect((await runToolsPipeline({ root, mode: 'integrity' })).driftPaths).toEqual([]);

    const modulePath = join(root, GENERATED_MODULE);
    const module = await readFile(modulePath, 'utf8');
    expect(module).toContain('"id": "filter.teamsMembersItem"');
    await writeFile(modulePath, module.replace('"id": "filter.teamsMembersItem"', '"id": "filter.tampered"'));
    const outcome = await runToolsPipeline({ root, mode: 'integrity' }).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
    expect((outcome as ToolsPipelineFailure).result.driftPaths).toEqual([GENERATED_MODULE]);
  }, 120_000);
});
