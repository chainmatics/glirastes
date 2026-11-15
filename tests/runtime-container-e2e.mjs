import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { readUIMessageStream } from 'ai';

// Requires Docker + built SDK. Optional GLIRASTES_RUNTIME_TEST_IMAGE runs the
// runtime itself in Docker. Without it only PHP/Postgres are containerized.
// PLAYWRIGHT_MODULE points to an already installed Playwright index.mjs.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = promisify(execFile);
const docker = async (...args) => (await run('docker', args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const json = (value) => JSON.stringify(value);
async function listen(server, host = '127.0.0.1') {
  await new Promise((done) => server.listen(0, host, done));
  return server.address().port;
}
async function close(server) {
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
}
async function eventually(check, message) {
  for (let n = 0; n < 100; n++) {
    try { if (await check()) return; } catch { /* startup */ }
    await delay(100);
  }
  throw new Error(message);
}
function user(text) { return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }; }
async function assistant(chunks) {
  let result;
  for await (const message of readUIMessageStream({ stream: new ReadableStream({
    start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); },
  }) })) result = message;
  return structuredClone(result);
}
function approve(message, approved = true, mutate = (part) => part) {
  return { ...message, parts: message.parts.map((part) => part.state === 'approval-requested'
    ? mutate({ ...part, state: 'approval-responded', approval: { id: part.approval.id, approved } }) : part) };
}

/** Deterministic test provider speaks the real OpenAI chat completions SSE. */
function modelStub(names, metrics) {
  return createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : last?.content?.find((part) => part.type === 'text')?.text ?? '';
    const call = last?.role === 'user'
      ? /complete/i.test(text) ? [names.write, { id: /task-b/.test(text) ? 'task-b' : 'task-a', status: 'done' }]
        : /highlight/i.test(text) ? [names.highlight, { taskId: 'task-a' }]
          : /list/i.test(text) ? [names.read, {}] : undefined
      : undefined;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish_reason = null) => response.write(`data: ${json({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (last?.role === 'user' && /slow model/i.test(text)) {
      metrics.slowStarted++;
      send({ content: 'Waiting for cancellation.' });
      const timer = setTimeout(() => { send({}, 'stop'); response.end('data: [DONE]\n\n'); }, 20_000);
      response.once('close', () => { clearTimeout(timer); if (!response.writableEnded) metrics.slowAborted++; });
      return;
    }
    if (call) {
      assert.ok(body.tools.some((tool) => tool.function.name === call[0]), `Expected tool ${call[0]} in model request`);
      send({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: call[0], arguments: json(call[1]) } }] });
      send({}, 'tool_calls');
    } else {
      send({ content: 'Reference response complete.' });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
}

test('PHP backend and official runtime preserve identity, authorization, streaming and approval replay protection', { timeout: 300_000 }, async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const network = `glirastes-runtime-e2e-${suffix}`;
  const names = { php: `${network}-php`, pg: `${network}-pg`, runtime: `${network}-runtime` };
  const runtimeImage = process.env.GLIRASTES_RUNTIME_TEST_IMAGE;
  const dir = await mkdtemp(join(ROOT, 'examples/.runtime-e2e-'));
  // Fixtures only: allow the image's non-root UID to traverse the bind mount
  // when the Linux CI runner has a different UID (macOS hides this difference).
  await chmod(dir, 0o755);
  let runtime; let runtimeOrigin; let ingress; let model; let browser;
  t.after(async () => {
    await browser?.close();
    await runtime?.stop();
    await close(ingress); await close(model);
    for (const name of Object.values(names)) await docker('rm', '-f', name).catch(() => {});
    await docker('network', 'rm', network).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, 'project'));
  // Do not copy a developer's .secrets, runtime.json or prepared artifacts.
  for (const part of ['api', 'web', '.glirastes']) {
    await cp(join(ROOT, 'examples/php-runtime', part), join(dir, 'project', part), { recursive: true });
  }
  await mkdir(join(dir, 'secrets'));
  for (const [file, value] of [['model', 'fixture-key'], ['approval', 'fixture-approval-secret-at-least-32-characters']]) await writeFile(join(dir, 'secrets', file), value);
  await run(process.execPath, [join(ROOT, 'dist/runtime-service/bin.js'), 'build', '--project', join(dir, 'project'), '--out', join(dir, 'artifact')]);
  const payload = JSON.parse(await readFile(join(dir, 'artifact/runtime.json'), 'utf8'));
  const toolNames = Object.fromEntries(payload.setupArtifact.tools.map((tool) => [
    tool.executionKind === 'ui' ? 'highlight' : tool.method === 'GET' ? 'read' : 'write', tool.modelName ?? tool.name.replaceAll('.', '_'),
  ]));
  assert.deepEqual(Object.keys(toolNames).sort(), ['highlight', 'read', 'write']);
  const modelMetrics = { slowStarted: 0, slowAborted: 0 };
  model = modelStub(toolNames, modelMetrics);
  const modelPort = await listen(model, runtimeImage ? '0.0.0.0' : '127.0.0.1');
  await docker('network', 'create', network);
  await docker('build', '-q', '-t', 'glirastes-runtime-php-fixture:local', '-f', join(ROOT, 'examples/php-runtime/api/Dockerfile'), join(ROOT, 'examples/php-runtime'));
  await docker('run', '--rm', '-d', '--name', names.php, '--network', network, '--network-alias', 'php', '-p', '127.0.0.1::8080', 'glirastes-runtime-php-fixture:local');
  await docker('run', '--rm', '-d', '--name', names.pg, '--network', network, '--network-alias', 'state', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=fixture-only', 'postgres:17-alpine');
  const apiPort = (await docker('port', names.php, '8080')).split(':').at(-1);
  const pgPort = (await docker('port', names.pg, '5432')).split(':').at(-1);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  await eventually(async () => (await fetch(`${apiOrigin}/healthz`)).ok, 'PHP did not start');
  assert.equal(`${await docker('exec', names.php, 'php', '/app/export-openapi.php')}\n`, await readFile(join(ROOT, 'examples/php-runtime/api/openapi.json'), 'utf8'), 'OpenAPI export is stale relative to the PHP contract');
  await eventually(async () => { await docker('exec', names.pg, 'pg_isready', '-U', 'postgres'); return true; }, 'PostgreSQL did not start');
  await run('bun', ['build', join(ROOT, 'examples/php-runtime/web/main.ts'), '--outdir', join(dir, 'web'), '--target', 'browser', '--format', 'esm', '--production']);
  ingress = createServer(async (request, response) => {
    if (request.url === '/' || request.url === '/main.js') {
      response.setHeader('content-type', request.url === '/' ? 'text/html' : 'text/javascript');
      response.end(await readFile(request.url === '/' ? join(ROOT, 'examples/php-runtime/web/index.html') : join(dir, 'web/main.js')));
      return;
    }
    const target = request.url?.startsWith('/glirastes/') ? runtimeOrigin : apiOrigin;
    if (!target) { response.writeHead(503).end(); return; }
    const upstream = httpRequest(new URL(request.url, target), { method: request.method, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  const origin = `http://127.0.0.1:${await listen(ingress)}`;
  const dbUrl = runtimeImage ? 'postgres://postgres:fixture-only@state:5432/postgres' : `postgres://postgres:fixture-only@127.0.0.1:${pgPort}/postgres`;
  await writeFile(join(dir, 'secrets/database'), dbUrl);
  const root = runtimeImage ? '/fixture' : dir;
  const reserve = createServer(); const runtimePort = runtimeImage ? 8787 : await listen(reserve); await close(reserve);
  const config = {
    schemaVersion: 1,
    server: { host: '0.0.0.0', port: runtimePort, publicOrigin: origin, drainTimeoutMs: 1000 },
    application: { artifact: `${root}/artifact`, apiOrigin: runtimeImage ? 'http://php:8080' : apiOrigin, allowedPathPrefixes: ['/api'] },
    identity: { endpoint: '/api/me', credential: { type: 'cookie', names: ['session'] } },
    model: { name: 'fixture', baseUrl: `http://${runtimeImage ? 'host.docker.internal' : '127.0.0.1'}:${modelPort}/v1`, apiKeyFile: `${root}/secrets/model` },
    approvals: { secretFile: `${root}/secrets/approval`, connectionStringFile: `${root}/secrets/database` },
    platform: { enabled: false },
  };
  await writeFile(join(dir, 'runtime-config.json'), json(config));
  async function start() {
    if (runtimeImage) {
      await docker('run', '--rm', '-d', '--name', names.runtime, '--network', network, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::8787', '-v', `${dir}:/fixture:ro`, runtimeImage, 'serve', '--config', '/fixture/runtime-config.json');
      runtimeOrigin = `http://127.0.0.1:${(await docker('port', names.runtime, '8787')).split(':').at(-1)}`;
      runtime = { stop: async () => { await docker('stop', '-t', '5', names.runtime); } };
    } else {
      const { parseRuntimeConfig } = await import('../dist/runtime-service/config.js');
      const { startRuntimeService } = await import('../dist/runtime-service/service.js');
      runtime = await startRuntimeService(parseRuntimeConfig(config));
      runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
    }
    await eventually(async () => (await fetch(`${runtimeOrigin}/readyz`)).ok, 'Runtime did not become ready');
  }
  await start();
  const state = () => fetch(`${apiOrigin}/fixture/state`).then((response) => response.json());
  async function chat(messages, cookie = 'alice', extra = {}) {
    const response = await fetch(`${origin}/glirastes/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `session=${cookie}; unrelated=must-not-forward` } : {}), ...extra }, body: json({ messages }) });
    const text = await response.text();
    return { response, text, chunks: text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6))) };
  }
  assert.equal((await chat([user('List tasks')], '')).response.status, 401);
  assert.equal((await chat([user('List tasks')], 'alice', { origin: 'https://evil.example' })).response.status, 403);
  const abort = new AbortController();
  const slow = await fetch(`${origin}/glirastes/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'session=alice' }, body: json({ messages: [user('Slow model')] }), signal: abort.signal });
  const reading = slow.text();
  await eventually(() => modelMetrics.slowStarted === 1, 'Slow model stream did not start');
  abort.abort();
  await assert.rejects(reading);
  await eventually(() => modelMetrics.slowAborted === 1, 'Browser disconnect did not cancel the provider request');
  const readA = await chat([user('List tasks')]);
  assert.equal(readA.response.status, 200);
  assert.match(readA.text, /Tenant A private task/); assert.doesNotMatch(readA.text, /Tenant B private task/);
  const readB = await chat([user('List tasks')], 'bob');
  assert.match(readB.text, /Tenant B private task/); assert.doesNotMatch(readB.text, /Tenant A private task/);
  assert.equal((await state()).lastCredentials.cookie.includes('unrelated'), false);

  async function pending(cookie = 'alice', text = 'Complete task-a') {
    const input = user(text); const first = await chat([input], cookie);
    assert.ok(first.chunks.some((chunk) => chunk.type === 'tool-approval-request'), first.text);
    return { input, message: await assistant(first.chunks) };
  }
  const denied = await pending();
  await chat([denied.input, approve(denied.message, false)]);
  assert.equal((await state()).writes['tenant-a'], 0);
  const changed = await pending();
  await chat([changed.input, approve(changed.message, true, (part) => ({ ...part, input: { ...part.input, status: 'open' } }))]);
  assert.equal((await state()).writes['tenant-a'], 0);
  await chat([changed.input, approve(changed.message)], 'bob');
  assert.equal((await state()).writes['tenant-b'], 0);
  const reader = await pending('reader-a');
  await chat([reader.input, approve(reader.message)], 'reader-a');
  assert.equal((await state()).writes['tenant-a'], 0, 'backend permissions survive a confirmed chat call');
  const allowed = await pending();
  const approvedMessages = [allowed.input, approve(allowed.message)];
  const done = await chat(approvedMessages);
  assert.equal((await state()).writes['tenant-a'], 1, done.text);
  await runtime.stop(); runtime = undefined; await start();
  await chat(approvedMessages);
  assert.equal((await state()).writes['tenant-a'], 1, 'restart must preserve consumed approvals');
  const contextMismatch = await fetch(`${apiOrigin}/api/tasks`, { headers: { cookie: 'session=alice', 'x-glirastes-business-tenant': 'tenant-b', 'x-glirastes-user-id': 'same-user-id' } });
  assert.equal(contextMismatch.status, 403);
  const revoked = await pending();
  await fetch(`${apiOrigin}/fixture/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ user: 'alice' }) });
  assert.equal((await chat([revoked.input, approve(revoked.message)])).response.status, 401);
  assert.equal((await state()).writes['tenant-a'], 1);
  await fetch(`${apiOrigin}/fixture/reset`, { method: 'POST' });

  await t.test('real browser streams a read, invokes a frontend action, and restores its local session', { skip: !process.env.PLAYWRIGHT_MODULE && 'Set PLAYWRIGHT_MODULE for the browser acceptance gate' }, async () => {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: 'alice', url: origin }]);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    const input = page.locator('glirastes-chat textarea'); await input.waitFor();
    await input.fill('List tasks'); await input.press('Enter');
    await page.locator('glirastes-chat').getByText('Reference response complete.', { exact: true }).waitFor();
    await input.fill('Highlight task-a'); await input.press('Enter');
    await page.locator('#task-a[data-highlighted="true"]').waitFor();
    await input.fill('Complete task-a'); await input.press('Enter');
    const confirm = page.locator('glirastes-chat [data-action="approve"]');
    await confirm.waitFor();
    assert.equal((await state()).writes['tenant-a'], 0, 'browser write waits for approval');
    await confirm.click();
    await eventually(async () => (await state()).writes['tenant-a'] === 1, 'Browser confirmation did not execute the write');
    await eventually(async () => await page.locator('glirastes-chat [data-action="approve"]').count() === 0, 'Browser approval continuation did not finish');
    await page.reload();
    await page.locator('glirastes-chat').getByText('List tasks', { exact: true }).waitFor();
    await context.addCookies([{ name: 'session', value: 'bob', url: origin }]);
    await page.reload();
    await page.locator('#task-b').waitFor();
    await page.locator('glirastes-chat textarea').waitFor();
    assert.equal(await page.locator('glirastes-chat').getByText('List tasks', { exact: true }).count(), 0, 'another workspace must not restore the first workspace conversation');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
