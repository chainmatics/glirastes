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

  it('refuses unbounded programs instead of analysing a partial app', async () => {
    const app = await createAppFixture();
    const rootNames = Array.from({ length: 5_001 }, (_, index) => join(app.root, `src/app/api/r${index}/route.ts`));
    expect(() => createAppProgram({ root: app.root, rootNames }))
      .toThrowError(expect.objectContaining({ code: 'E-INVENTORY-011' }));
  });
});
