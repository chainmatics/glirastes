import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineResult,
} from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

const NOTES_SCHEMAS = "import { z } from 'zod';\n\n"
  + "export const listNotesInput = z.object({ pinned: z.enum(['true', 'false']).optional() }).strict();\n"
  + 'export const listNotesOutput = z.object({\n'
  + '  notes: z.array(z.object({ id: z.string(), title: z.string(), pinned: z.boolean() })),\n'
  + "}).describe('List your notes, optionally only pinned ones.');\n"
  + 'export const createNoteInput = z.object({ title: z.string().min(1) }).strict();\n'
  + 'export const noteOutput = z.object({ id: z.string(), title: z.string(), pinned: z.boolean() })\n'
  + "  .describe('Create a note for yourself.');\n";

const NOTES_ROUTE = "import { createNoteInput, listNotesInput, listNotesOutput, noteOutput } from './schemas.js';\n"
  + "import { query } from '../../../query.js';\n"
  + "import { resolveSession } from '../../../auth.js';\n\n"
  + 'const notes = [];\n\n'
  + 'export async function GET(request) {\n'
  + '  return query(request, listNotesInput, listNotesOutput, (input, principal) => ({\n'
  + '    notes: notes\n'
  + '      .filter((note) => note.owner === principal.subjectId && (!input.pinned || String(note.pinned) === input.pinned))\n'
  + '      .map(({ id, title, pinned }) => ({ id, title, pinned })),\n'
  + '  }));\n}\n\n'
  + 'export async function POST(request) {\n'
  + '  const principal = resolveSession(request);\n'
  + "  if (!principal) return Response.json({ error: 'Unauthenticated' }, { status: 401 });\n"
  + '  const input = createNoteInput.safeParse(await request.json());\n'
  + "  if (!input.success) return Response.json({ error: 'Invalid note' }, { status: 400 });\n"
  + '  const note = { id: String(notes.length + 1), title: input.data.title, pinned: false, owner: principal.subjectId };\n'
  + '  notes.push(note);\n'
  + '  return Response.json(noteOutput.parse({ id: note.id, title: note.title, pinned: note.pinned }), { status: 201 });\n}\n';

async function artifactOf(root: string): Promise<AppSetupArtifact> {
  return AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

/** `glirastes tools check`: frozen refresh that must fail with a named drift finding. */
async function failingCheck(root: string): Promise<ToolsPipelineResult> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const { result } = outcome as ToolsPipelineFailure;
  expect(result.wrote).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'tool-outputs-drift', subjectRef: '.glirastes/foundation-execution-inventory.json' }),
  ]));
  return result;
}

async function passingCheck(root: string): Promise<void> {
  expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
}

const byToolId = (left: { toolId: string }, right: { toolId: string }) => (left.toolId < right.toolId ? -1 : 1);

describe('Next endpoint change corpus', () => {
  it('adds an endpoint: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = before.tools[0]!.toolId;
    await mkdir(join(root, 'src/app/api/notes'), { recursive: true });
    await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
    await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);

    expect((await failingCheck(root)).changes.added).toHaveLength(2);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(2);
    expect(refreshed.changes.unchanged).toEqual([tasksId]);
    const after = await artifactOf(root);
    const byName = new Map(after.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get('tasks.list')?.toolId).toBe(tasksId);
    expect(byName.get('notes.list')).toMatchObject({
      method: 'GET', operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(byName.get('notes.create')).toMatchObject({
      method: 'POST', operationGroup: 'create', riskClass: 'write', requiresApproval: true, enabled: true,
    });
    const added = compareArtifacts(before, after)
      .filter((change) => refreshed.changes.added.includes(change.toolId))
      .sort(byToolId);
    expect(added).toEqual(refreshed.changes.added
      .map((toolId) => ({ toolId, classification: 'added', fields: ['toolId'], requiresConfirmation: false }))
      .sort(byToolId));
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const alice = principal();
    const turn = app.turn({ cookie: `session=${app.createSession(alice)}` });
    expect(await turn.guard.resolveApproval({ toolName: 'notes_create', input: { title: 'Buy milk' } })).toBe(true);
    expect(await turn.guard.resolveApproval({ toolName: 'notes_list', input: {} })).toBe(false);
    expect(await turn.execute('notes_create', { title: 'Buy milk' })).toMatchObject({
      success: true, id: '1', title: 'Buy milk', pinned: false,
    });
    expect(await turn.execute('notes_list', {})).toMatchObject({
      success: true, notes: [{ id: '1', title: 'Buy milk', pinned: false }],
    });
    const withoutSession = app.turn({ resolvePrincipal: () => alice });
    expect(await withoutSession.execute('notes_create', { title: 'Sneaky' })).toMatchObject({
      success: false, error: 'Unauthenticated',
    });
  }, 240_000);

  it('changes an endpoint: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = (await artifactOf(root)).tools[0]!;
    await replaceIn(root, 'src/app/api/tasks/contract.js',
      "status: z.enum(['open', 'done']).optional()", "status: z.enum(['done']).optional()");
    await replaceIn(root, 'src/app/api/tasks/route.js', 'Write tests', 'Write verified tests');

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = (await artifactOf(root)).tools[0]!;
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    await expect(turn.execute('tasks_list', { status: 'open' })).rejects.toThrow('Input does not match');
    expect(await turn.execute('tasks_list', { status: 'done' })).toMatchObject({
      success: true, tasks: [{ id: '2', title: 'Write verified tests', status: 'done' }],
    });
  }, 240_000);

  it('removes an endpoint: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = (await artifactOf(root)).tools[0]!.toolId;
    await rm(join(root, 'src/app/api/tasks/route.js'));

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools).toEqual([]);
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(Object.keys(turn.registry)).toEqual([]);
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});
