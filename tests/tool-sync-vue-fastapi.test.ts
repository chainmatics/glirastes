import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import { runToolsPipeline, ToolsPipelineFailure } from '../src/codegen/tools/pipeline.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  exportOpenapi,
  principal,
  pythonReady,
  removeCopiedApps,
  VUE_APP,
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

// Python 3.12 with api/requirements.txt is a declared prerequisite of this fixture (its own CI job).
const PYTHON_READY = pythonReady();

beforeAll(() => {
  assertBuiltSdk();
});
afterEach(async () => {
  await closeFastapiApps();
  await removeCopiedApps();
});

const NOTES_ROUTER = [
  'from fastapi import APIRouter, Depends',
  'from pydantic import BaseModel, ConfigDict, Field',
  '',
  'from .sessions import CurrentUser, session_user',
  '',
  '',
  'class Note(BaseModel):',
  '    id: str',
  '    title: str',
  '',
  '',
  'class NoteList(BaseModel):',
  '    notes: list[Note]',
  '',
  '',
  'class NoteCreate(BaseModel):',
  "    model_config = ConfigDict(extra='forbid')",
  '    title: str = Field(min_length=1)',
  '',
  '',
  '_notes: dict[str, list[Note]] = {}',
  "router = APIRouter(prefix='/api/notes', tags=['notes'], dependencies=[Depends(session_user)])",
  '',
  '',
  "@router.get('', response_model=NoteList)",
  'def list_notes(user: CurrentUser) -> NoteList:',
  '    """List your notes."""',
  '    return NoteList(notes=_notes.get(user.subjectId, []))',
  '',
  '',
  "@router.post('', status_code=201, response_model=Note)",
  'def create_note(user: CurrentUser, body: NoteCreate) -> Note:',
  '    """Create a note for yourself."""',
  '    notes = _notes.setdefault(user.subjectId, [])',
  '    note = Note(id=str(len(notes) + 1), title=body.title)',
  '    notes.append(note)',
  '    return note',
  '',
].join('\n');

const LIST_ROUTE = "@router.get('', response_model=TaskList)\n"
  + 'def list_tasks(user: CurrentUser, status: TaskStatus | None = None) -> TaskList:\n'
  + '    """List your tasks, optionally only open or done ones."""\n'
  + '    return TaskList(tasks=[task for task in tasks_of(user.subjectId) if status is None or task.status == status])\n\n\n';

/** `glirastes tools check` while the committed export is older than the code. */
async function staleExportCheck(root: string): Promise<string> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const finding = (outcome as ToolsPipelineFailure).result.findings.find((candidate) => candidate.code === 'E-INVENTORY-011');
  expect(finding).toBeDefined();
  return finding!.message;
}

describe.skipIf(!PYTHON_READY)('Vue+FastAPI endpoint change corpus', () => {
  it('adds a router: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = toolNamed(before, 'tasks.list').toolId;
    await writeFile(join(root, 'api/app/notes.py'), NOTES_ROUTER);
    await replaceIn(root, 'api/app/main.py', 'from .tasks import router as tasks_router\n',
      'from .notes import router as notes_router\nfrom .tasks import router as tasks_router\n');
    await replaceIn(root, 'api/app/main.py', 'app.include_router(tasks_router)\n',
      'app.include_router(tasks_router)\napp.include_router(notes_router)\n');

    // The code moved, the export did not: the count stops the check before any drift is computed.
    expect(await staleExportCheck(root))
      .toBe('api/openapi.json lists 3 operations, the FastAPI code in api/app declares 5; run the export again.');
    await exportOpenapi(root);
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

    const app = await bootFastapiApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.token}` });
    expect(await turn.guard.resolveApproval({ toolName: 'notes_create', input: { title: 'Buy milk' } })).toBe(true);
    expect(await turn.guard.resolveApproval({ toolName: 'notes_list', input: {} })).toBe(false);
    expect(await turn.execute('notes_create', { title: 'Buy milk' })).toMatchObject({ success: true, id: '1', title: 'Buy milk' });
    await expect(turn.execute('notes_create', { title: '' })).rejects.toThrow('Input does not match');
    const bearer = app.turn({ authorization: `Bearer ${app.token}` });
    expect(await bearer.execute('notes_list', {})).toMatchObject({ success: true, notes: [{ id: '1', title: 'Buy milk' }] });
    const withoutSession = app.turn({ resolvePrincipal: () => principal() });
    expect(await withoutSession.execute('notes_create', { title: 'Sneaky' })).toMatchObject({
      success: false, error: 'Unauthenticated',
    });
  }, 240_000);

  it('changes a Pydantic model: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const before = toolNamed(await artifactOf(root), 'tasks.list');
    await replaceIn(root, 'api/app/tasks.py',
      'def list_tasks(user: CurrentUser, status: TaskStatus | None = None) -> TaskList:',
      "def list_tasks(user: CurrentUser, status: Literal['done'] | None = None) -> TaskList:");
    await replaceIn(root, 'api/app/tasks.py', 'Ship the fixture', 'Ship the verified fixture');
    await exportOpenapi(root);

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = toolNamed(await artifactOf(root), 'tasks.list');
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
    await passingCheck(root);

    const app = await bootFastapiApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.token}` });
    await expect(turn.execute('tasks_list', { status: 'open' })).rejects.toThrow('Input does not match');
    expect(await turn.execute('tasks_list', { status: 'done' })).toMatchObject({
      success: true, tasks: [{ id: '2', title: 'Ship the verified fixture', status: 'done' }],
    });
  }, 240_000);

  it('removes a route: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = toolNamed(await artifactOf(root), 'tasks.list').toolId;
    await replaceIn(root, 'api/app/tasks.py', LIST_ROUTE, '');
    await exportOpenapi(root);

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(await tombstonesOf(root)).toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools.filter((tool) => tool.executionKind === 'endpoint').map((tool) => tool.name))
      .toEqual(['tasks.create']);
    await passingCheck(root);

    const app = await bootFastapiApp(await copyApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.token}` });
    expect(Object.keys(turn.registry)).not.toContain('tasks_list');
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});

describe.skipIf(!PYTHON_READY)('Vue+FastAPI agentic entry', () => {
  it('answers through the Node chat runtime, its tool calling FastAPI with the caller\'s cookie', async () => {
    const root = await copyApp(VUE_APP, '.tool-sync-vue-');
    await runToolsPipeline({ root, mode: 'write' });
    await passingCheck(root);
    const report = JSON.parse(await readFile(join(root, '.glirastes/tool-report.json'), 'utf8')) as {
      findings: Array<{ code: string; subjectRef: string }>;
    };
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'route-hidden', subjectRef: 'api/app/main.py:16' }),
    ]));
    const app = await bootFastapiApp(root, scriptedModel);
    const cookie = `session=${app.token}`;

    const response = await fetch(`${app.runtimeOrigin}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: chatBody('Show done tasks'),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"toolName":"tasks_list"');
    expect(stream).toContain('Ship the fixture');
    expect(stream).not.toContain('Write tests');
    expect(stream).toContain('Reference response complete.');

    const anonymous = await fetch(`${app.runtimeOrigin}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('Show done tasks'),
    });
    expect(anonymous.status).toBe(401);
    expect(await fetch(`${app.apiOrigin}/api/tasks`)).toMatchObject({ status: 401 });
  }, 240_000);
});
