import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const port = 3191;
const origin = `http://localhost:${port}`;
const message = (text) => ({ messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }] });

// macOS answers kill(-pgid) with EPERM instead of ESRCH while every member of
// the group is a zombie awaiting reaping. These groups are always our own
// detached children (same uid, no setuid), so EPERM can only mean "gone".
const GROUP_GONE = new Set(['ESRCH', 'EPERM']);
const systemKill = (pid, signal) => process.kill(pid, signal);

function processGroupAlive(pid, kill = systemKill) {
  try { kill(-pid, 0); return true; } catch (error) { if (GROUP_GONE.has(error.code)) return false; throw error; }
}

function killProcessGroupQuietly(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; }
}

async function stopProcessGroup(child, graceMs = 3_000, kill = systemKill) {
  const alive = () => processGroupAlive(child.pid, kill);
  const signal = (name) => { try { kill(-child.pid, name); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; } };
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

const UNREAL_PID = 2 ** 30; // above every Linux/macOS pid_max: real kill() can only answer ESRCH
const killError = (code) => Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' });

test('reference cleanup treats a zombie-only process group (EPERM on macOS) as stopped', { timeout: 10_000 }, async () => {
  const sent = [];
  const zombieGroup = (pid, signal) => { sent.push([pid, signal]); throw killError('EPERM'); };
  await stopProcessGroup({ pid: UNREAL_PID }, 30, zombieGroup);
  assert.deepEqual(sent, [[-UNREAL_PID, 0]]);
});

test('reference cleanup stops waiting once the group becomes zombies after SIGTERM', { timeout: 10_000 }, async () => {
  const sent = [];
  let terminated = false;
  const exitsOnTerm = (pid, signal) => {
    sent.push(signal);
    if (signal === 'SIGTERM') { terminated = true; return true; }
    if (terminated) throw killError('EPERM');
    return true;
  };
  await stopProcessGroup({ pid: UNREAL_PID }, 1_000, exitsOnTerm);
  assert.deepEqual(sent.slice(0, 2), [0, 'SIGTERM']);
  assert.equal(sent.includes('SIGKILL'), false);
});

test('reference cleanup still surfaces unexpected kill errors', { timeout: 10_000 }, async () => {
  const broken = () => { throw killError('EINVAL'); };
  await assert.rejects(stopProcessGroup({ pid: UNREAL_PID }, 30, broken), { code: 'EINVAL' });
});

test('reference cleanup escalates when its own child ignores SIGTERM', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  t.after(() => killProcessGroupQuietly(child.pid));
  await once(child.stdout, 'data');
  assert.equal(typeof stopProcessGroup, 'function', 'bounded process-group cleanup is missing');
  await stopProcessGroup(child, 30);
  // A zombie-only group counts as stopped before Node has reaped the leader.
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  assert.equal(child.signalCode, 'SIGKILL');
});

test('reference cleanup also stops descendants after the group leader exits', { timeout: 10_000 }, async (t) => {
  const descendant = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  t.after(() => killProcessGroupQuietly(child.pid));
  await once(child.stdout, 'data');
  await stopProcessGroup(child, 30);
  assert.equal(processGroupAlive(child.pid), false);
});

test('real Next SDK chat streams native endpoint results and updates the browser UI', { timeout: 180_000 }, async (t) => {
  const module = await import('../examples/source-driven-next/prepare-browser.mjs').catch(() => ({}));
  assert.equal(typeof module.prepareBrowserReference, 'function', 'the real Next reference preparer is missing');
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const root = await module.prepareBrowserReference();
  const navigationDigest = async () => JSON.parse(await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8'))
    .executions.find((entry) => entry.definitionId === 'ui.navigate').inputSchemaDigest;
  const initialDigest = await navigationDigest();
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
  // Prove the normal app dev/build command picks up a new page AFTER setup.
  await mkdir(resolve(root, 'src/app/(app)/archive'), { recursive: true });
  await writeFile(resolve(root, 'src/app/(app)/archive/page.jsx'),
    'export default function Archive() { return <section data-testid="native-ui"><h1>Archive</h1></section>; }\n');
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
  assert.notEqual(await navigationDigest(), initialDigest, 'normal app command did not regenerate after a page change');
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
  assert.equal(new URL(page.url()).pathname, '/overview');
  await chat('Filter done tasks');
  await native.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await native.getByText('Write tests', { exact: true }).waitFor();
  assert.equal(await native.getByText('Review release', { exact: true }).count(), 0);
  assert.equal(await native.getByLabel('Status').inputValue(), 'done');
  assert.equal(new URL(page.url()).search, '?status=done');
  await chat('Highlight Write tests');
  await native.locator('li[aria-current="true"]', { hasText: 'Write tests' }).waitFor();
  if (process.env.REFERENCE_SCREENSHOT) await page.screenshot({ path: process.env.REFERENCE_SCREENSHOT, fullPage: true });
  await page.goto(`${origin}/layout-proof`);
  const layoutDraft = page.getByRole('textbox');
  await page.getByText('Ask your app to help').waitFor();
  await layoutDraft.fill('Retained across layouts');
  const panel = page.locator('[data-component="chat-window"]');
  const divider = page.getByRole('separator', { name: 'Resize chat sidebar' });
  const dividerBox = await divider.boundingBox();
  assert.ok(dividerBox && dividerBox.width >= 6 && dividerBox.height > 100, 'sidebar needs a usable resize target');
  const mainBox = await page.getByTestId('layout-main').boundingBox();
  const sideBox = await panel.boundingBox();
  assert.ok(mainBox.x + mainBox.width <= sideBox.x + 1, 'sidebar must reserve app space');
  await divider.focus();
  await divider.press('ArrowLeft');
  assert.equal(Math.round((await panel.boundingBox()).width), 440);
  await page.getByRole('button', { name: 'Float chat', exact: true }).click();
  assert.equal(Math.round((await panel.boundingBox()).width), 672);
  await page.getByRole('button', { name: 'Dock chat', exact: true }).click();
  assert.equal(Math.round((await panel.boundingBox()).width), 440);
  const grip = await divider.boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 100);
  await page.mouse.down();
  await page.mouse.move(grip.x - 26, grip.y + 100);
  await page.mouse.move(grip.x - 56, grip.y + 100);
  await page.mouse.up();
  assert.equal(Math.round((await panel.boundingBox()).width), 500, 'multiple pointer moves must survive app-persisted width updates');
  await page.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Expand chat', exact: true }).evaluate(element => element === document.activeElement), true, 'collapse must leave keyboard focus on the expand action');
  assert.equal(await layoutDraft.isVisible(), false);
  assert.equal(Math.round((await panel.boundingBox()).width), 44);
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  assert.equal(await layoutDraft.inputValue(), 'Retained across layouts');
  assert.equal(await layoutDraft.evaluate(element => element === document.activeElement), true, 'expansion must return focus to the editor');
  if (process.env.REFERENCE_LAYOUT_SCREENSHOT) await page.screenshot({ path: `${process.env.REFERENCE_LAYOUT_SCREENSHOT}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await panel.boundingBox();
  assert.equal(Math.round(mobileBox.width), 390);
  assert.equal(Math.round(mobileBox.height), 844);
  if (process.env.REFERENCE_LAYOUT_SCREENSHOT) await page.screenshot({ path: `${process.env.REFERENCE_LAYOUT_SCREENSHOT}-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  assert.equal(Math.round((await panel.boundingBox()).width), 44, 'collapsed mobile rail must not cover the app');
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.getByRole('button', { name: 'Open assistant', exact: true }).click();
  assert.equal(await layoutDraft.inputValue(), 'Retained across layouts');
  assert.equal(await layoutDraft.evaluate(element => element === document.activeElement), true, 'retained reopen must focus the actual drop-in composer');
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /Module not found|Error:|Warning:/);
  t.diagnostic('Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim.');
});
