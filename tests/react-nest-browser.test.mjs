import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ALICE, SDK, TENANT_ID, copyReference, launchBrowser, proveChatTools, scriptedModel, startVite, stopGroup } from './browser/reference-apps.mjs';

// React + NestJS in real Chrome: `bun install --frozen-lockfile` in examples/react-nest-separate/api
// and .../web, and an installed Playwright. Run:
// PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node --test tests/react-nest-browser.test.mjs
test('React chat element drives react-router, a nuqs filter and a page action through the Nest API', { timeout: 180_000 }, async (t) => {
  const root = await copyReference('react-nest-separate', ['api', 'web']);
  const processes = [];
  let api;
  let browser;
  t.after(async () => {
    await browser?.close();
    await api?.close();
    for (const child of processes) await stopGroup(child);
    await rm(root, { recursive: true, force: true });
  });
  await promisify(execFile)(process.execPath, [join(SDK, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'api')]);
  const dist = (file) => pathToFileURL(join(root, 'api/dist', file)).href;
  const { createApi } = await import(dist('app.js'));
  const { createSession } = await import(dist('auth/sessions.js'));
  let apiOrigin = '';
  api = await createApi({ model: scriptedModel, apiOrigin: () => apiOrigin, tenantId: TENANT_ID });
  await api.listen(0, '127.0.0.1');
  apiOrigin = await api.getUrl();
  const token = createSession(ALICE);
  const origin = await startVite(join(root, 'web'), 3195, { API_ORIGIN: apiOrigin }, processes);
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
  assert.equal(await page.getByLabel('Status').inputValue(), 'done');
  assert.deepEqual(errors, []);
});
