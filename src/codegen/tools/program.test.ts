import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { createAppProgram, readAppCompilerOptions } from './program.js';

afterEach(removeAppFixtures);

function moduleOfFirstImport(program: ReturnType<typeof createAppProgram>, file: string): string | undefined {
  const sourceFile = program.sourceFile(file)!;
  const declaration = sourceFile.statements.find(ts.isImportDeclaration)!;
  const symbol = program.checker.getSymbolAtLocation(declaration.moduleSpecifier);
  const target = symbol?.valueDeclaration;
  return target && ts.isSourceFile(target) ? program.appRelative(target.fileName) : undefined;
}

describe('createAppProgram', () => {
  it('resolves tsconfig path aliases to app files and keeps libraries outside', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() });\n",
      'src/app/api/tasks/route.ts': "import { createTask } from '@/lib/schemas';\n"
        + 'export async function POST(request: Request) {\n'
        + '  return Response.json(createTask.parse(await request.json()));\n}\n',
    });
    const routeFile = join(app.root, 'src/app/api/tasks/route.ts');
    const program = createAppProgram({ root: app.root, rootNames: [routeFile] });
    expect(moduleOfFirstImport(program, routeFile)).toBe('src/lib/schemas.ts');
    const zodFile = program.program.getSourceFiles()
      .find((file) => file.fileName.includes('/node_modules/zod/'));
    expect(zodFile).toBeDefined();
    expect(program.appRelative(zodFile!.fileName)).toBeUndefined();
    expect(program.appRelative(routeFile)).toBe('src/app/api/tasks/route.ts');
  });

  it('reads JavaScript apps without a tsconfig', async () => {
    const app = await createAppFixture({
      'src/schemas.js': "import { z } from 'zod';\nexport const listInput = z.object({ q: z.string().optional() });\n",
      'src/app/api/items/route.js': "import { listInput } from '../../../schemas.js';\n"
        + 'export async function GET(request) {\n'
        + '  return Response.json(listInput.parse(Object.fromEntries(new URL(request.url).searchParams)));\n}\n',
    });
    const routeFile = join(app.root, 'src/app/api/items/route.js');
    const program = createAppProgram({ root: app.root, rootNames: [routeFile] });
    expect(moduleOfFirstImport(program, routeFile)).toBe('src/schemas.js');
    expect(readAppCompilerOptions(app.root).allowJs).toBeUndefined();
  });

  it('uses the root tsconfig for a single-package app, wherever the scan starts', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/schemas.ts': 'export const a = 1;\n',
      'src/app/page.ts': "import { a } from '@/lib/schemas';\nexport const b = a;\n",
    });
    const pageFile = join(app.root, 'src/app/page.ts');
    for (const searchFrom of [undefined, '.', 'src', 'src/app']) {
      const program = createAppProgram({ root: app.root, rootNames: [pageFile], ...(searchFrom ? { searchFrom } : {}) });
      expect(program.tsconfig).toBe('tsconfig.json');
      expect(moduleOfFirstImport(program, pageFile)).toBe('src/lib/schemas.ts');
    }
  }, 60_000);

  it('uses the tsconfig nearest to the scanned folder in a monorepo, never one above the app root', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'apps/web/tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, baseUrl: '.', paths: { '@contracts/*': ['src/contracts/*'] } },
      }),
      'apps/web/src/contracts/ui.ts': 'export const a = 1;\n',
      'apps/web/src/page.ts': "import { a } from '@contracts/ui';\nexport const b = a;\n",
    });
    const pageFile = join(app.root, 'apps/web/src/page.ts');
    const nested = createAppProgram({ root: app.root, rootNames: [pageFile], searchFrom: 'apps/web/src' });
    expect(nested.tsconfig).toBe('apps/web/tsconfig.json');
    expect(moduleOfFirstImport(nested, pageFile)).toBe('apps/web/src/contracts/ui.ts');
    const rootOnly = createAppProgram({ root: app.root, rootNames: [pageFile] });
    expect(rootOnly.tsconfig).toBe('tsconfig.json');
    expect(moduleOfFirstImport(rootOnly, pageFile)).toBeUndefined();
  });

  it('honours extends and the paths of the extended tsconfig', async () => {
    const app = await createAppFixture({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { strict: true, baseUrl: '.', paths: { '@shared/*': ['packages/shared/src/*'] } },
      }),
      'apps/web/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { jsx: 'preserve' } }),
      'packages/shared/src/ui.ts': 'export const a = 1;\n',
      'apps/web/src/page.ts': "import { a } from '@shared/ui';\nexport const b = a;\n",
    });
    const pageFile = join(app.root, 'apps/web/src/page.ts');
    const program = createAppProgram({ root: app.root, rootNames: [pageFile], searchFrom: 'apps/web/src' });
    expect(program.tsconfig).toBe('apps/web/tsconfig.json');
    expect(moduleOfFirstImport(program, pageFile)).toBe('packages/shared/src/ui.ts');
  });

  it('follows project references to the project that contains the scanned files', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.app.json' }] }),
      'tsconfig.node.json': JSON.stringify({ compilerOptions: { composite: true }, include: ['vite.config.ts'] }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { composite: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
        include: ['src'],
      }),
      'vite.config.ts': 'export default {};\n',
      'src/lib/schemas.ts': 'export const a = 1;\n',
      'src/page.ts': "import { a } from '@/lib/schemas';\nexport const b = a;\n",
    });
    const pageFile = join(app.root, 'src/page.ts');
    const program = createAppProgram({ root: app.root, rootNames: [pageFile], searchFrom: 'src' });
    expect(program.tsconfig).toBe('tsconfig.app.json');
    expect(moduleOfFirstImport(program, pageFile)).toBe('src/lib/schemas.ts');
  });

  it('uses TypeScript defaults without a tsconfig inside the app', async () => {
    const app = await createAppFixture({ 'src/page.ts': 'export const b = 1;\n' });
    const program = createAppProgram({ root: app.root, rootNames: [join(app.root, 'src/page.ts')], searchFrom: 'src' });
    expect(program.tsconfig).toBeUndefined();
    expect(readAppCompilerOptions(app.root, { searchFrom: 'src' }).types).toEqual([]);
  });

  it('takes a tsconfig named in tools.json over the search and refuses one that does not exist', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'apps/web/tsconfig.build.json': JSON.stringify({
        compilerOptions: { strict: true, baseUrl: '.', paths: { '@contracts/*': ['src/contracts/*'] } },
      }),
      'apps/web/src/contracts/ui.ts': 'export const a = 1;\n',
      'apps/web/src/page.ts': "import { a } from '@contracts/ui';\nexport const b = a;\n",
    });
    const pageFile = join(app.root, 'apps/web/src/page.ts');
    const program = createAppProgram({
      root: app.root, rootNames: [pageFile], searchFrom: 'apps/web/src', tsconfig: 'apps/web/tsconfig.build.json',
    });
    expect(program.tsconfig).toBe('apps/web/tsconfig.build.json');
    expect(moduleOfFirstImport(program, pageFile)).toBe('apps/web/src/contracts/ui.ts');
    expect(() => createAppProgram({ root: app.root, rootNames: [pageFile], tsconfig: 'apps/web/tsconfig.missing.json' }))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-002' }));
  });

  it('refuses unbounded programs instead of analysing a partial app', async () => {
    const app = await createAppFixture();
    const rootNames = Array.from({ length: 5_001 }, (_, index) => join(app.root, `src/app/api/r${index}/route.ts`));
    expect(() => createAppProgram({ root: app.root, rootNames }))
      .toThrowError(expect.objectContaining({ code: 'E-INVENTORY-011' }));
  });
});
