import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const port = 3191;
const origin = `http://localhost:${port}`;
const message = (text) => ({ messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }] });

async function stopProcessGroup(child, graceMs = 3_000) {
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const signal = (name) => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const wait = async (ms) => {
    const deadline = Date.now() + ms;
    while (alive() && Date.now() < deadline) await delay(20);
    return !alive();
  };
  if (!alive()) return;
  signal('SIGTERM');
  if (await wait(graceMs)) return;
  signal('SIGKILL');
  assert.ok(await wait(2_000), 'test process group did not stop after SIGKILL');
}

test('reference cleanup escalates when its own child ignores SIGTERM', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await once(child.stdout, 'data');
  assert.equal(typeof stopProcessGroup, 'function', 'bounded process-group cleanup is missing');
  await stopProcessGroup(child, 30);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('reference cleanup also stops descendants after the group leader exits', { timeout: 10_000 }, async (t) => {
  const descendant = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await once(child.stdout, 'data');
  await stopProcessGroup(child, 30);
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
});

test('real Next SDK chat streams native endpoint results and updates the browser UI', { timeout: 180_000 }, async (t) => {
  const module = await import('../examples/source-driven-next/prepare-browser.mjs').catch(() => ({}));
  assert.equal(typeof module.prepareBrowserReference, 'function', 'the real Next reference preparer is missing');
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const root = await module.prepareBrowserReference();
  const navigationDigest = (text) => JSON.parse(text.match(/^export const generationState = (.+);$/m)[1])
    .inventory.executions.find((entry) => entry.definitionId === 'ui.navigate').inputSchemaDigest;
  const initialDigest = navigationDigest(await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8'));
  let server;
  let browser;
  const processes = [];
  t.after(async () => {
    try {
      const outcomes = await Promise.allSettled([
        ...processes.map((child) => stopProcessGroup(child)),
        ...(browser ? [Promise.race([browser.close(), delay(5_000, undefined, { ref: false }).then(() => { throw new Error('Browser cleanup timed out'); })])] : []),
      ]);
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), 'Reference cleanup failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  // Prove the normal app dev/build command picks up changes AFTER setup.
  const configFile = resolve(root, 'src/ui-config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.views.push({ id: 'archive', label: 'Archive', filters: [] });
  await writeFile(configFile, JSON.stringify(config));
  const capability = randomUUID();
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: '1', GLIRASTES_REFERENCE_TEST_MODE: '1',
    GLIRASTES_REFERENCE_CAPABILITY: capability };
  let logs = '';
  function start(args) {
    const child = spawn('bun', ['run', ...args],
      { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child);
    const abort = () => { void stopProcessGroup(child).catch(() => {}); };
    t.signal.addEventListener('abort', abort, { once: true });
    child.once('exit', () => t.signal.removeEventListener('abort', abort));
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    return child;
  }
  if (process.env.REFERENCE_NEXT_MODE === 'production') {
    const build = start(['build']);
    const [code] = await once(build, 'exit');
    assert.equal(code, 0, logs);
    logs = '';
  }
  server = start([process.env.REFERENCE_NEXT_MODE === 'production' ? 'start' : 'dev']);
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(server.exitCode, null, logs);
    if (logs.includes('Ready in')) break;
    await delay(100);
  }
  assert.match(logs, /Ready in/);
  const generatedText = await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8');
  assert.notEqual(navigationDigest(generatedText), initialDigest, 'normal app command did not regenerate after native UI change');
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const denied = await post('/chat', message('Show done tasks'));
  assert.equal(denied.status, 401);
  assert.equal((await post('/session', {})).status, 403);
  const login = await post('/session', {}, { 'x-reference-capability': capability });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await post('/chat', message('Show done tasks'), { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const wire = await response.text();
  assert.match(wire, /tool-output-available/);
  assert.match(wire, /Write tests/);
  assert.doesNotMatch(wire, /Private task|"type":"error"|"success":false/);

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext();
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(`${entry.text()} ${entry.location().url}`); });
  await page.goto(origin);
  const native = page.getByTestId('native-ui');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const input = page.getByRole('textbox', { name: 'Type a message...' });
  async function chat(text) {
    await input.fill(text);
    const streamed = page.waitForResponse((response) => response.url() === `${origin}/chat` && response.request().method() === 'POST');
    await input.press('Enter');
    const result = await streamed;
    assert.equal(result.status(), 200);
    await result.finished();
  }
  await chat('Go to overview');
  await native.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await chat('Filter done tasks');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await native.getByText('Write tests', { exact: true }).waitFor();
  assert.equal(await native.getByText('Review release', { exact: true }).count(), 0);
  assert.equal(await native.getByLabel('Status').inputValue(), 'done');
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, SDK chat, navigation and filtering. Test model only; no LLM/STT/timing claim.');
});
