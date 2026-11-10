import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import {
  assertBuiltSdk,
  assertNestInstalled,
  bootNestApp,
  closeNestApps,
  copyNestApp,
  NEST_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';
import {
  artifactOf,
  byToolId,
  chatBody,
  failingCheck,
  passingCheck,
  replaceIn,
  scriptedModel,
  tombstonesOf,
  toolNamed,
} from './support/tool-sync.js';

beforeAll(() => {
  assertBuiltSdk();
  assertNestInstalled();
});
afterEach(async () => {
  await closeNestApps();
  await removeCopiedApps();
});

const NOTES_SCHEMAS = "import { z } from 'zod';\n\n"
  + "export const listNotesQuery = z.object({ pinned: z.enum(['true', 'false']).optional() }).strict();\n"
  + 'export const noteOutput = z.object({ id: z.string(), title: z.string(), pinned: z.boolean() });\n'
  + 'export const listNotesOutput = z.object({ notes: z.array(noteOutput) })\n'
  + "  .describe('List your notes, optionally only pinned ones.');\n"
  + 'export const createNoteInput = z.object({ title: z.string().min(1) }).strict();\n';

const NOTES_CONTROLLER = "import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';\n"
  + "import { SessionGuard, type SessionRequest } from '../auth/session.guard.js';\n"
  + "import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';\n"
  + "import { createNoteInput, listNotesOutput, listNotesQuery, noteOutput } from './notes.schemas.js';\n\n"
  + 'const notes: Array<{ id: string; title: string; pinned: boolean; owner: string }> = [];\n\n'
  + "@Controller('notes')\n@UseGuards(SessionGuard)\nexport class NotesController {\n"
  + '  @Get()\n'
  + "  list(@Query(new ZodValidationPipe(listNotesQuery)) query: { pinned?: 'true' | 'false' }, @Req() request: SessionRequest) {\n"
  + '    return listNotesOutput.parse({ notes: notes\n'
  + '      .filter((note) => note.owner === request.user!.subjectId && (!query.pinned || String(note.pinned) === query.pinned))\n'
  + '      .map(({ id, title, pinned }) => ({ id, title, pinned })) });\n  }\n\n'
  + '  /** Create a note for yourself. */\n'
  + '  @Post()\n'
  + '  create(@Body(new ZodValidationPipe(createNoteInput)) body: { title: string }, @Req() request: SessionRequest) {\n'
  + '    const note = { id: String(notes.length + 1), title: body.title, pinned: false, owner: request.user!.subjectId };\n'
  + '    notes.push(note);\n'
  + '    return noteOutput.parse({ id: note.id, title: note.title, pinned: note.pinned });\n  }\n}\n';

const LIST_METHOD = '  @Get()\n'
  + '  list(@Query(new ZodValidationPipe(listTasksQuery)) query: ListTasksQuery, @Req() request: SessionRequest) {\n'
  + '    const tasks = tasksOf(request.user!.subjectId).filter((task) => !query.status || task.status === query.status);\n'
  + '    return listTasksOutput.parse({ tasks });\n  }\n\n';

describe('React+NestJS endpoint change corpus', () => {
  it('adds a controller: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyNestApp(NEST_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = toolNamed(before, 'tasks.list').toolId;
    await mkdir(join(root, 'api/src/notes'), { recursive: true });
    await writeFile(join(root, 'api/src/notes/notes.schemas.ts'), NOTES_SCHEMAS);
    await writeFile(join(root, 'api/src/notes/notes.controller.ts'), NOTES_CONTROLLER);
    await replaceIn(root, 'api/src/app.module.ts', "import { TasksController } from './tasks/tasks.controller.js';",
      "import { NotesController } from './notes/notes.controller.js';\nimport { TasksController } from './tasks/tasks.controller.js';");
    await replaceIn(root, 'api/src/app.module.ts', 'controllers: [TasksController, ChatController]',
      'controllers: [TasksController, NotesController, ChatController]');

    expect((await failingCheck(root)).changes.added).toHaveLength(2);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(2);
    expect([...refreshed.changes.unchanged].sort()).toEqual(before.tools.map((tool) => tool.toolId).sort());
    const after = await artifactOf(root);
    const byName = new Map(after.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get('tasks.list')?.toolId).toBe(tasksId);
    expect(byName.get('notes.list')).toMatchObject({
      method: 'GET', path: '/api/notes', operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(byName.get('notes.create')).toMatchObject({
      method: 'POST', path: '/api/notes', operationGroup: 'create', riskClass: 'write', requiresApproval: true, enabled: true,
    });
    expect(compareArtifacts(before, after).filter((change) => refreshed.changes.added.includes(change.toolId)).sort(byToolId))
      .toEqual(refreshed.changes.added
        .map((toolId) => ({ toolId, classification: 'added', fields: ['toolId'], requiresConfirmation: false }))
        .sort(byToolId));
    await passingCheck(root);

    const app = await bootNestApp(await copyNestApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const alice = principal();
    const turn = app.turn({ cookie: `session=${app.createSession(alice)}` });
    expect(await turn.guard.resolveApproval({ toolName: 'notes_create', input: { title: 'Buy milk' } })).toBe(true);
    expect(await turn.guard.resolveApproval({ toolName: 'notes_list', input: {} })).toBe(false);
    expect(await turn.execute('notes_create', { title: 'Buy milk' })).toMatchObject({
      success: true, id: '1', title: 'Buy milk', pinned: false,
    });
    const bearer = app.turn({ authorization: `Bearer ${app.createSession(alice)}` });
    expect(await bearer.execute('notes_list', {})).toMatchObject({
      success: true, notes: [{ id: '1', title: 'Buy milk', pinned: false }],
    });
    const withoutSession = app.turn({ resolvePrincipal: () => alice });
    expect(await withoutSession.execute('notes_create', { title: 'Sneaky' })).toMatchObject({
      success: false, error: 'Unauthenticated',
    });
  }, 240_000);

  it('changes a pipe schema: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyNestApp(NEST_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'tasks.list');
    await replaceIn(root, 'api/src/tasks/tasks.schemas.ts',
      "export const listTasksQuery = z.object({ status: z.enum(['open', 'done']).optional() })",
      "export const listTasksQuery = z.object({ status: z.enum(['done']).optional() })");
    await replaceIn(root, 'api/src/tasks/tasks.store.ts', 'Ship the fixture', 'Ship the verified fixture');

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = toolNamed(await artifactOf(root), 'tasks.list');
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
    await passingCheck(root);

    const app = await bootNestApp(await copyNestApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    await expect(turn.execute('tasks_list', { status: 'open' })).rejects.toThrow('Input does not match');
    expect(await turn.execute('tasks_list', { status: 'done' })).toMatchObject({
      success: true, tasks: [{ id: '2', title: 'Ship the verified fixture', status: 'done' }],
    });
  }, 240_000);

  it('removes a handler: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyNestApp(NEST_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = toolNamed(await artifactOf(root), 'tasks.list').toolId;
    await replaceIn(root, 'api/src/tasks/tasks.controller.ts', LIST_METHOD, '');
    await replaceIn(root, 'api/src/tasks/tasks.controller.ts', 'Body, Controller, Get, Post', 'Body, Controller, Post');
    await replaceIn(root, 'api/src/tasks/tasks.controller.ts', '  listTasksOutput,\n  listTasksQuery,\n', '');
    await replaceIn(root, 'api/src/tasks/tasks.controller.ts', '  type ListTasksQuery,\n', '');

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(await tombstonesOf(root)).toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools.filter((tool) => tool.executionKind === 'endpoint').map((tool) => tool.name))
      .toEqual(['tasks.create']);
    await passingCheck(root);

    const app = await bootNestApp(await copyNestApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(Object.keys(turn.registry)).not.toContain('tasks_list');
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});

describe('React+NestJS agentic entry', () => {
  it('answers through the Nest chat controller, its tool calling the API with the caller\'s cookie', async () => {
    const root = await copyNestApp(NEST_APP);
    await runToolsPipeline({ root, mode: 'write' });
    await passingCheck(root);
    const app = await bootNestApp(root, scriptedModel);
    const cookie = `session=${app.createSession(principal())}`;

    const response = await fetch(`${app.origin}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: chatBody('Show done tasks'),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"toolName":"tasks_list"');
    expect(stream).toContain('Ship the fixture');
    expect(stream).not.toContain('Write tests');
    expect(stream).toContain('Reference response complete.');

    const anonymous = await fetch(`${app.origin}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('Show done tasks'),
    });
    expect(anonymous.status).toBe(401);
    expect(await fetch(`${app.origin}/api/tasks`)).toMatchObject({ status: 401 });
  }, 240_000);
});
