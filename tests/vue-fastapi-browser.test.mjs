import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ALICE, TENANT_ID, copyReference, launchBrowser, proveChatTools, scriptedModel, startVite, stopGroup } from './browser/reference-apps.mjs';

// Vue + FastAPI in real Chrome: Python 3.12 with examples/vue-fastapi/api/requirements.txt,
// `bun install --frozen-lockfile` in examples/vue-fastapi/web, and an installed Playwright. Run:
// PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test tests/vue-fastapi-browser.test.mjs
const PYTHON = process.env.GLIRASTES_TEST_PYTHON ?? 'python3';
const pythonReady = spawnSync(PYTHON, ['-I', '-c', 'import fastapi, uvicorn, pydantic']).status === 0;

function startUvicorn(root, sessions, processes) {
  const child = spawn(PYTHON, ['-I', '-B', '-m', 'uvicorn', '--app-dir', join(root, 'api'), 'app.main:app', '--host', '127.0.0.1', '--port', '0'], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH ?? '', FIXTURE_SESSIONS: JSON.stringify(sessions) },
  });
  processes.push(child);
  return new Promise((started, failed) => {
    let log = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      log += chunk;
      const origin = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1];
      if (origin) started(origin);
    });
    child.on('exit', (code) => failed(new Error(`uvicorn exited with ${String(code)}:\n${log}`)));
  });
}

test('Vue chat element drives the router, a URL filter and a view action, styled by the host and unmounted cleanly', {
  timeout: 180_000, skip: !pythonReady && `${PYTHON} with fastapi, uvicorn and pydantic is not installed`,
}, async (t) => {
  const root = await copyReference('vue-fastapi', ['web']);
  const processes = [];
  let runtime;
  let browser;
  t.after(async () => {
    await browser?.close();
    if (runtime) await new Promise((closed) => runtime.close(() => closed()));
    for (const child of processes) await stopGroup(child);
    await rm(root, { recursive: true, force: true });
  });
  const token = randomUUID();
  const apiOrigin = await startUvicorn(root, { [token]: ALICE }, processes);
  const { createChatRuntime } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href);
  const chat = createChatRuntime({ apiOrigin: () => apiOrigin, model: scriptedModel, tenantId: TENANT_ID });
  assert.deepEqual(chat.disabled, []);
  runtime = chat.server;
  await new Promise((listening) => runtime.listen(0, '127.0.0.1', listening));
  const origin = await startVite(join(root, 'web'), 3194, {
    API_ORIGIN: apiOrigin, RUNTIME_ORIGIN: `http://127.0.0.1:${runtime.address().port}`,
  }, processes);
  const anonymous = await fetch(`${origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Go to overview' }] }] }) });
  assert.equal(anonymous.status, 401);

  browser = await launchBrowser();
  const context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: token, url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`${origin}/tasks`);
  await proveChatTools(page, origin);

  // Styling: the host page's CSS variable reaches the panel inside the shadow root only.
  const styled = await page.evaluate(() => {
    const panel = document.querySelector('glirastes-chat').shadowRoot.querySelector('[data-component="ai-chat-panel"]');
    return { primary: getComputedStyle(panel).getPropertyValue('--cm-primary').trim(),
      leaked: document.querySelectorAll('[data-component="ai-chat-panel"]').length };
  });
  assert.deepEqual(styled, { primary: '#2f5bd3', leaked: 0 });
  // Unmount: leaving the view unregisters its action; removing the element empties its shadow root.
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.locator('section[aria-label="Overview"] h1').waitFor();
  const remaining = await page.evaluate(async () => {
    const host = document.querySelector('glirastes-chat');
    host.remove();
    await new Promise((done) => setTimeout(done, 0));
    return host.shadowRoot.childNodes.length;
  });
  assert.equal(remaining, 0);
  assert.deepEqual(errors, []);
});
