// Run after building: node scripts/verify-agent-entry.mjs
// Exercises the shipped executable, not just runCli. No model or network call.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'glirastes-built-agent-entry-'));
try {
  const dotenv = 'GLIRASTES_SETUP_AGENT_ACTIVE=dotenv-must-not-be-loaded\n';
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15', react: '19' } }));
  await writeFile(join(root, '.env'), dotenv);
  await writeFile(join(root, '.env.local'), dotenv);
  const hook = join(root, '.verify-no-env.mjs');
  await writeFile(hook, `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename } from 'node:path';
    let attempted = false;
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (['.env', '.env.local'].includes(basename(String(path)))) {
        attempted = true;
        throw new Error('Environment-file access forbidden in this probe');
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    process.on('exit', () => { if (attempted) process.exitCode = 98; });
  `);
  const initial = (await readdir(root)).sort();
  const run = (args) => {
    const result = spawnSync(process.execPath, ['--import', hook, join(sdkRoot, 'dist/cli/bin.js'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH ?? '', CODEX_THREAD_ID: 'local-verification-only' },
    });
    assert.equal(result.status, 0, 'Built command must succeed without implicit dotenv reads');
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1, 'Exactly one JSON result');
    return JSON.parse(result.stdout);
  };
  const inspection = run(['setup', 'inspect', '--json']);
  assert.equal(inspection.schemaVersion, 1);
  const preview = run(['init', '--dry-run', '--json']);
  assert.equal(preview.status, 'preview');
  assert.equal(preview.agent, 'codex');
  assert.deepEqual((await readdir(root)).sort(), initial, 'Preview must not write files');
  const handback = run(['init', '--json']);
  assert.equal(handback.status, 'continue-in-session');
  assert.ok(handback.instructions.includes('successful authorized tool action'));
  assert.ok((await readFile(join(root, '.agents/skills/setting-up-glirastes/SKILL.md'), 'utf8')).includes('Setting Up Glirastes'));
  assert.equal(await readFile(join(root, '.env'), 'utf8'), dotenv);
  assert.equal(await readFile(join(root, '.env.local'), 'utf8'), dotenv);
  console.log('PASS: built inspect, init preview and same-session entry; no implicit dotenv reads, no agent/model/network launch.');
} finally {
  await rm(root, { recursive: true, force: true });
}
