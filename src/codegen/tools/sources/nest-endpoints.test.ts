import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createRouteSourceFingerprint } from '../../route-scanner.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createNestEndpointSource } from './nest-endpoints.js';

afterEach(removeAppFixtures);

const POLICY = ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} });

function context(root: string): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: POLICY,
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

const byKey = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.stableKey, observation] as const),
);

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, types: [] },
});
const MAIN = "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module.js';\n"
  + "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api');\nawait app.listen(3000);\n";
const GUARD = "import { Injectable, type CanActivate } from '@nestjs/common';\n"
  + '@Injectable()\nexport class SessionGuard implements CanActivate {\n  canActivate() { return true; }\n}\n';
const PIPE = "import { Injectable, type PipeTransform } from '@nestjs/common';\nimport type { ZodType } from 'zod';\n"
  + '@Injectable()\nexport class ZodValidationPipe implements PipeTransform {\n'
  + '  constructor(private readonly schema: ZodType) {}\n  transform(value: unknown) { return this.schema.parse(value); }\n}\n';
const SCHEMAS = "import { z } from 'zod';\n"
  + "export const createTaskSchema = z.object({ title: z.string().min(1) }).strict();\n"
  + "export const listTasksQuerySchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();\n"
  + "export const taskSchema = z.object({ id: z.string(), title: z.string() });\n";
const CONTROLLER = "import { Body, Controller, Delete, Get, Options, Param, Post, Query, UseGuards } from '@nestjs/common';\n"
  + "import { SessionGuard } from './session.guard.js';\nimport { ZodValidationPipe } from './zod.pipe.js';\n"
  + "import { createTaskSchema, listTasksQuerySchema, taskSchema } from './tasks.schemas.js';\n"
  + "@Controller('tasks')\n@UseGuards(SessionGuard)\nexport class TasksController {\n"
  + '  /** Lists the caller\'s tasks. */\n'
  + "  @Get()\n  list(@Query(new ZodValidationPipe(listTasksQuerySchema)) query: { status?: 'open' | 'done' }) {\n"
  + '    return [{ id: \'1\', title: String(query.status) }];\n  }\n'
  + "  @Post()\n  create(@Body(new ZodValidationPipe(createTaskSchema)) body: { title: string }) {\n"
  + "    return taskSchema.parse({ id: '2', title: body.title });\n  }\n"
  + "  @Delete(':id')\n  remove(@Param('id') id: string) {\n    return { deleted: id };\n  }\n"
  + "  @Options()\n  options() {\n    return {};\n  }\n}\n";
const OPEN = "import { Body, Controller, Post } from '@nestjs/common';\n"
  + "@Controller({ path: 'open' })\nexport class OpenController {\n"
  + '  @Post()\n  submit(@Body() body: unknown) {\n    return { received: body };\n  }\n}\n';
const CHAT = "import { Controller, Post, Req } from '@nestjs/common';\n"
  + "import { createAiChatHandler } from 'glirastes/server/nextjs';\n"
  + "@Controller('chat')\nexport class ChatController {\n  @Post()\n  chat(@Req() request: unknown) {\n    return createAiChatHandler;\n  }\n}\n";

const APP = {
  'tsconfig.json': TSCONFIG,
  'src/main.ts': MAIN,
  'src/session.guard.ts': GUARD,
  'src/zod.pipe.ts': PIPE,
  'src/tasks.schemas.ts': SCHEMAS,
  'src/tasks.controller.ts': CONTROLLER,
  'src/open.controller.ts': OPEN,
  'src/chat.controller.ts': CHAT,
};

describe('nest endpoint source', () => {
  it('turns every controller handler into a tool, an attention item or a reasoned exclusion', async () => {
    const app = await createAppFixture(APP, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.complete).toBe(true);
    expect(observed.findings).toEqual([]);
    expect(observed.excluded).toEqual([
      { stableKey: 'OPTIONS /api/tasks', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'POST /api/chat', reason: 'chat-handler', origin: 'default' },
    ]);
    const tools = byKey(observed.observations);
    expect(Object.fromEntries([...tools].map(([key, tool]) => [key, tool.execution.definitionId]))).toEqual({
      'DELETE /api/tasks/:id': 'tasks.delete',
      'GET /api/tasks': 'tasks.list',
      'POST /api/open': 'open.create',
      'POST /api/tasks': 'tasks.create',
    });
    expect(tools.get('POST /api/tasks')!.execution).toMatchObject({
      executionKind: 'endpoint',
      sourceKind: 'nest',
      sourceFile: 'src/tasks.controller.ts',
      sourceFingerprint: createRouteSourceFingerprint(CONTROLLER, 'POST', '/api/tasks'),
    });
  });

  it('reads Zod pipes as the input contract and a parsed return as the output', async () => {
    const app = await createAppFixture(APP, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const tools = byKey((await createNestEndpointSource().observe(context(app.root))).observations);

    const create = tools.get('POST /api/tasks')!;
    expect(create.contract).toMatchObject({
      source: 'native',
      loadBearing: true,
      params: { path: [], query: [], body: ['title'] },
      input: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] },
      output: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
      runtime: {
        input: { kind: 'module-export', module: 'src/tasks.schemas.ts', export: 'createTaskSchema' },
        output: { kind: 'module-export', module: 'src/tasks.schemas.ts', export: 'taskSchema' },
      },
    });
    expect(create.files).toEqual(['src/tasks.controller.ts', 'src/tasks.schemas.ts']);
    expect(create.evidence).toEqual({ authEvidence: true, externalCall: false });
    expect(create.findings).toEqual([]);

    const list = tools.get('GET /api/tasks')!;
    expect(list.contract).toMatchObject({
      source: 'native',
      params: { query: ['status'] },
      input: { properties: { status: { enum: ['open', 'done'] } } },
    });
    expect(list.evidence.jsDoc).toBe("Lists the caller's tasks.");

    expect(tools.get('DELETE /api/tasks/:id')!.contract!.params).toEqual({ path: ['id'], query: [], body: [] });
  });

  it('keeps an unguarded or schema-less handler disabled with a reason', async () => {
    const app = await createAppFixture(APP, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const open = byKey((await createNestEndpointSource().observe(context(app.root))).observations).get('POST /api/open')!;

    expect(open.evidence.authEvidence).toBe(false);
    expect(open.findings.map((finding) => finding.code)).toContain('auth-evidence-missing');
    expect(open.interface!.params.body).toBe('opaque');
  });

  it('counts a global guard and a createZodDto body validated by a global pipe', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/main.ts': MAIN,
      'src/app.module.ts': "import { Module } from '@nestjs/common';\nimport { APP_GUARD, APP_PIPE } from '@nestjs/core';\n"
        + "import { ZodValidationPipe } from 'nestjs-zod';\nimport { SessionGuard } from './session.guard.js';\n"
        + '@Module({ providers: [{ provide: APP_GUARD, useClass: SessionGuard }, { provide: APP_PIPE, useClass: ZodValidationPipe }] })\n'
        + 'export class AppModule {}\n',
      'src/session.guard.ts': GUARD,
      'src/notes.schemas.ts': "import { z } from 'zod';\nexport const createNoteSchema = z.object({ text: z.string() }).strict();\n",
      'src/notes.dto.ts': "import { createZodDto } from 'nestjs-zod';\nimport { createNoteSchema } from './notes.schemas.js';\n"
        + 'export class CreateNoteDto extends createZodDto(createNoteSchema) {}\n',
      'src/notes.controller.ts': "import { Body, Controller, Post } from '@nestjs/common';\nimport { CreateNoteDto } from './notes.dto.js';\n"
        + "@Controller('notes')\nexport class NotesController {\n"
        + '  @Post()\n  add(@Body() body: CreateNoteDto) {\n    return { ok: true };\n  }\n}\n',
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const note = byKey((await createNestEndpointSource().observe(context(app.root))).observations).get('POST /api/notes')!;

    expect(note.evidence.authEvidence).toBe(true);
    expect(note.contract).toMatchObject({
      source: 'native',
      input: { properties: { text: { type: 'string' } } },
      runtime: { input: { kind: 'module-export', module: 'src/notes.schemas.ts', export: 'createNoteSchema' } },
    });
  });

  it.each([
    ['a computed controller path', "const base = 'tasks';\n@Controller(base)", 'is not one string literal'],
    ['RouterModule', "import { RouterModule } from '@nestjs/core';\nvoid RouterModule;\n@Controller('tasks')", 'uses RouterModule'],
  ])('stops with E-INVENTORY-011 for %s', async (_label, header, message) => {
    const app = await createAppFixture({
      ...APP,
      'src/tasks.controller.ts': CONTROLLER.replace("@Controller('tasks')", header),
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011', severity: 'error' })]);
    expect(observed.findings[0]!.message).toContain(message);
  });

  it('stops with E-INVENTORY-011 for a computed global prefix', async () => {
    const app = await createAppFixture({ ...APP, 'src/main.ts': MAIN.replace("setGlobalPrefix('api')", 'setGlobalPrefix(process.env.PREFIX!)') },
      { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message).toContain('global prefix that is not one string literal');
  });

  it('reports a wildcard route as an exclusion instead of guessing its parameters', async () => {
    const app = await createAppFixture({
      ...APP,
      'src/tasks.controller.ts': CONTROLLER.replace("@Delete(':id')", "@Delete('*path')"),
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.excluded).toContainEqual({ stableKey: 'DELETE /api/tasks/*path', reason: 'unsupported-path', origin: 'code' });
  });
  it('keeps a createZodDto body disabled when no global pipe validates it', async () => {
    const app = await createAppFixture({
      'tsconfig.json': TSCONFIG,
      'src/main.ts': MAIN,
      'src/session.guard.ts': GUARD,
      'src/notes.schemas.ts': "import { z } from 'zod';\nexport const createNoteSchema = z.object({ text: z.string() }).strict();\n",
      'src/notes.dto.ts': "import { createZodDto } from 'nestjs-zod';\nimport { createNoteSchema } from './notes.schemas.js';\n"
        + 'export class CreateNoteDto extends createZodDto(createNoteSchema) {}\n',
      'src/notes.controller.ts': "import { Body, Controller, Post, UseGuards } from '@nestjs/common';\nimport { SessionGuard } from './session.guard.js';\n"
        + "import { CreateNoteDto } from './notes.dto.js';\n@Controller('notes')\n@UseGuards(SessionGuard)\nexport class NotesController {\n"
        + '  @Post()\n  add(@Body() body: CreateNoteDto) {\n    return { ok: true };\n  }\n}\n',
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const note = byKey((await createNestEndpointSource().observe(context(app.root))).observations).get('POST /api/notes')!;

    expect(note.findings.map((finding) => finding.code)).toContain('nest-dto-unvalidated');
    expect(note.interface!.params.body).toBe('opaque');
    expect(note.contract?.loadBearing).not.toBe(true);
  });

  it('stops with E-INVENTORY-011 when the app enables versioning', async () => {
    const app = await createAppFixture({
      ...APP,
      'src/main.ts': MAIN.replace('await app.listen(3000);', 'app.enableVersioning();\nawait app.listen(3000);'),
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message).toContain('enables versioning');
  });

  it('reports two handlers for one route as E-INVENTORY-010 and an @All route as an exclusion', async () => {
    const app = await createAppFixture({
      ...APP,
      'src/tasks.controller.ts': CONTROLLER.replace('{ Body, Controller,', '{ All, Body, Controller,').replace("@Options()", "@All('any')\n  any() {\n    return {};\n  }\n  @Get()\n  again() {\n    return [];\n  }\n  @Options()"),
    }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
    const observed = await createNestEndpointSource().observe(context(app.root));

    expect(observed.findings).toContainEqual(expect.objectContaining({ code: 'E-INVENTORY-010', severity: 'error' }));
    expect(observed.excluded).toContainEqual({ stableKey: 'ALL /api/tasks/any', reason: 'unsupported-method', origin: 'code' });
  });
});
