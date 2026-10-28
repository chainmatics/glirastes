import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_RUN_LIMIT_BYTES, redactSecrets, Workspace, WorkspaceRefusal } from '../workspace.js';

let root: string;

async function put(path: string, content: string | Buffer): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

function workspace(options: Partial<{ ignored: string[]; creatable: string[] }> = {}) {
  const ignored = new Set(options.ignored ?? []);
  return new Workspace({
    root,
    isIgnored: async (paths) => new Set(paths.filter((path) => ignored.has(path))),
    writableFiles: ['.glirastes/tool-resolutions.json', '.glirastes/tool-semantics.json'],
    creatableFiles: options.creatable ?? [],
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkspaceRefusal) return error.code;
    throw error;
  }
  return 'no refusal';
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glirastes-workspace-'));
  await put('src/app/api/tasks/route.ts', 'export async function GET() { return Response.json([]); }\n');
  await put('src/lib/db.ts', "const url = 'postgres://app:hunter2@db.internal/app';\nexport const password = 'correct-horse-battery';\n");
  await put('.env.local', 'OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789\n');
  await put('.npmrc', '//registry.npmjs.org/:_authToken=secret\n');
  await put('certs/server.pem', 'pem');
  await put('node_modules/pkg/index.js', 'module.exports = 1;\n');
  await put('.git/config', '[core]\n');
  await put('.glirastes/platform-connection.json', '{}\n');
  await put('.glirastes/tool-resolutions.json', '{"schemaVersion":1,"entries":{}}\n');
  await put('generated.log', 'route.ts GET\n');
  await symlink(join(root, 'src'), join(root, 'linked'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('managed job workspace', () => {
  it('lists and reads the checkout without denied, ignored or linked paths', async () => {
    const files = await workspace({ ignored: ['generated.log'] }).listFiles('', true);

    expect(files).toEqual([
      '.glirastes/',
      'certs/',
      'src/',
      '.glirastes/tool-resolutions.json',
      'src/app/',
      'src/lib/',
      'src/app/api/',
      'src/lib/db.ts',
      'src/app/api/tasks/',
      'src/app/api/tasks/route.ts',
    ]);
  });

  it('refuses every path outside the sandbox with a named code', async () => {
    const space = workspace({ ignored: ['generated.log'] });

    expect(await Promise.all([
      refusal(space.readFile('../outside.txt')),
      refusal(space.readFile('/etc/passwd')),
      refusal(space.readFile('.env.local')),
      refusal(space.readFile('.npmrc')),
      refusal(space.readFile('certs/server.pem')),
      refusal(space.readFile('node_modules/pkg/index.js')),
      refusal(space.readFile('.git/config')),
      refusal(space.readFile('.glirastes/platform-connection.json')),
      refusal(space.readFile('generated.log')),
      refusal(space.readFile('linked/lib/db.ts')),
      refusal(space.readFile('src/missing.ts')),
      refusal(space.readFile('.GIT/config')),
      refusal(space.readFile('Node_Modules/pkg/index.js')),
      refusal(space.readFile('.Glirastes/Platform-Connection.json')),
    ])).toEqual([
      'path_invalid', 'path_invalid', 'path_denied', 'path_denied', 'path_denied', 'path_denied',
      'path_denied', 'path_denied', 'path_ignored', 'path_symlink', 'path_missing',
      'path_denied', 'path_denied', 'path_denied',
    ]);
    expect(space.bytesRead).toBe(0);
  });

  it('redacts secrets in what it reads and greps', async () => {
    const space = workspace();

    const read = await space.readFile('src/lib/db.ts');
    const matches = await space.grep('hunter2');

    expect(read.content).toBe("const url = '[redacted connection string]';\nexport const password = '[redacted]';\n");
    expect(matches).toEqual([{ path: 'src/lib/db.ts', line: 1, text: "const url = '[redacted connection string]';" }]);
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets(`key gl_${'a'.repeat(32)} and sk-or-v1-0123456789abcdef`)).toBe('key [redacted key] and [redacted key]');
  });

  it('cuts a file at 64 KB and stops at 400 KB for the run', async () => {
    await put('src/big.ts', 'x'.repeat(100 * 1024));
    const space = workspace();

    const first = await space.readFile('src/big.ts');
    for (let index = 0; index < 5; index += 1) await space.readFile('src/big.ts');

    expect([first.content.length, first.truncated, space.bytesRead]).toEqual([64 * 1024, true, 6 * 64 * 1024]);
    expect(await refusal(space.readFile('src/big.ts'))).toBe('read_budget_exhausted');
    expect(space.bytesRead).toBeLessThanOrEqual(READ_RUN_LIMIT_BYTES);
  });

  it('writes only the agentic data files and new contract files', async () => {
    const space = workspace({ creatable: ['src/app/api/tasks/contract.ts'] });
    const resolutions = JSON.stringify({ schemaVersion: 1, entries: { 'GET /api/tasks': {} } });

    await space.writeFile('.glirastes/tool-resolutions.json', resolutions);
    await space.writeFile('src/app/api/tasks/contract.ts', 'export const input = {};');
    await space.writeFile('src/app/api/tasks/contract.ts', 'export const input = { a: 1 };');

    expect(await readFile(join(root, '.glirastes/tool-resolutions.json'), 'utf8')).toBe(`${resolutions}\n`);
    expect([...space.written].sort()).toEqual(['.glirastes/tool-resolutions.json', 'src/app/api/tasks/contract.ts']);
    expect(await Promise.all([
      refusal(space.writeFile('.glirastes/tool-policy.json', '{}')),
      refusal(space.writeFile('src/app/api/tasks/route.ts', 'export {}')),
      refusal(space.writeFile('.glirastes/tool-semantics.json', 'not json')),
      refusal(space.writeFile('.glirastes/tool-semantics.json', '[]')),
      refusal(space.writeFile('.glirastes/tool-semantics.json', JSON.stringify({ hint: 'sk-or-v1-0123456789abcdef0123' }))),
      refusal(workspace({ creatable: ['src/lib/db.ts'] }).writeFile('src/lib/db.ts', 'export {}')),
    ])).toEqual([
      'write_not_allowed', 'write_not_allowed', 'write_invalid_json', 'write_invalid_json',
      'write_content_refused', 'write_exists',
    ]);
  });
});
