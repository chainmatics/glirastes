import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MockLanguageModelV3 } from 'ai/test';

export const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TENANT_ID = '019fb007-0000-7000-8000-000000000002';
export const ALICE = { subjectId: 'alice', tenantId: TENANT_ID, roles: ['member'], attributes: {} };

/** The tool the scripted model calls for each chat message; after the tool result it answers. */
const SCRIPT = new Map([
  ['Go to overview', ['ui_navigate', { destination: '/overview' }]],
  ['Filter done tasks', ['ui_filter_tasks', { status: 'done' }]],
  ['Highlight Ship the fixture', ['ui_tasks_highlight', { title: 'Ship the fixture' }]],
]);
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export function scriptedModel() {
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const last = prompt.at(-1);
    const text = last?.role === 'user' ? last.content.find((part) => part.type === 'text')?.text : undefined;
    const call = text === undefined ? undefined : SCRIPT.get(text);
    const chunks = call
      ? [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `call-${call[0]}`, toolName: call[0], input: JSON.stringify(call[1]) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
      ]
      : [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'Reference response complete.' },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
      ];
    return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
  } });
}

/**
 * A disposable copy of a reference app inside the SDK tree, the local SDK
 * linked as `glirastes`, the fixture's installed `node_modules` linked per
 * part, and its first `glirastes tools refresh`.
 */
export async function copyReference(fixture, installedParts) {
  const source = join(SDK, 'examples', fixture);
  const root = await mkdtemp(join(SDK, 'examples', `.browser-proof-${fixture}-`));
  await cp(source, root, { recursive: true, filter: (path) => !path.split(sep).includes('node_modules') });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(SDK, join(root, 'node_modules/glirastes'), 'dir');
  for (const part of installedParts) {
    await symlink(join(source, part, 'node_modules'), join(root, part, 'node_modules'), 'dir');
  }
  await promisify(execFile)(process.execPath, [join(SDK, 'dist/cli/bin.js'), 'tools', 'refresh', '--root', root],
    { env: { PATH: process.env.PATH ?? '' } });
  return root;
}

/** Starts the app's Vite dev server on a fixed local port; returns its origin. */
export async function startVite(web, port, env, processes) {
  const child = spawn(process.execPath, [join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: web, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', GLIRASTES_SDK_DIR: SDK, ...env },
  });
  processes.push(child);
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  for (let attempt = 0; attempt < 300 && !/ready in/i.test(logs); attempt++) {
    assert.equal(child.exitCode, null, logs);
    await delay(100);
  }
  assert.match(logs, /ready in/i);
  return `http://127.0.0.1:${port}`;
}

/** Stops a detached child and everything it started. */
export async function stopGroup(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise((done) => child.once('exit', done)), delay(3_000)]);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
}

export async function launchBrowser() {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  return chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
}

/**
 * Drives the embedded chat by keyboard: navigation, a URL filter and a client
 * action of the open page, each through the app's own router or handler.
 */
export async function proveChatTools(page, origin) {
  const textarea = page.locator('glirastes-chat textarea');
  await textarea.waitFor();
  assert.equal(await textarea.getAttribute('placeholder'), 'Ask about your tasks');
  async function chat(text) {
    const answered = page.waitForResponse((response) => response.url() === `${origin}/api/chat` && response.request().method() === 'POST');
    await textarea.focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    const response = await answered;
    assert.equal(response.status(), 200);
    await response.finished();
  }
  // The app's own list, outside the chat's shadow root.
  const tasks = page.locator('section[aria-label="Tasks"]');
  await tasks.locator('li', { hasText: 'Write tests' }).waitFor();
  await chat('Go to overview');
  await page.locator('section[aria-label="Overview"] h1').waitFor();
  assert.equal(new URL(page.url()).pathname, '/overview');
  await chat('Filter done tasks');
  await tasks.locator('li', { hasText: 'Ship the fixture' }).waitFor();
  assert.equal(new URL(page.url()).search, '?status=done');
  assert.equal(await tasks.locator('li', { hasText: 'Write tests' }).count(), 0);
  await chat('Highlight Ship the fixture');
  await tasks.locator('li[aria-current="true"]', { hasText: 'Ship the fixture' }).waitFor();
}
