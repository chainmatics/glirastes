import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';
const run=promisify(execFile);
it('unconfigured SDK preserves the actual ordinary HTTP transport of fixed upstream f29b3607',async()=>{
  // Captured from the built, untouched fixed upstream with the same probe.
  const expected=JSON.parse(await readFile(new URL('./fixtures/privacy-default-f29b3607.json',import.meta.url),'utf8'));
  const {stdout}=await run('node',[fileURLToPath(new URL('./fixtures/privacy-default-probe.mjs',import.meta.url)),process.cwd()],{timeout:15000});
  const actual=JSON.parse(stdout);
  expect(actual).toEqual(expected);
  expect(actual.status).toBe(200);expect(actual.requests).toHaveLength(1);expect(actual.errors).toEqual([]);
  expect(JSON.stringify(actual.requests)).toContain('ordinary.canary@example.invalid');expect(actual.privacyStatus).toBe(false);
});
