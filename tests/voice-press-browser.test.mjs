import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Press-and-hold and tap on the mic button, in real Chrome with a fake
// microphone. jsdom has no hit testing, no touch-to-click compatibility
// events and no layout shift, and those decide what a finger does here:
// recording starts on pointerdown, the inline recording bar mounts at once
// and moves the controls, and the browser then hit-tests the tap's click
// against the NEW layout.
// Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome \
//   node --test tests/voice-press-browser.test.mjs
const root = fileURLToPath(new URL('..', import.meta.url));
const HOLD_MS = 450; // longer than the 350 ms hold threshold
const SETTLE_MS = 600;

let workDir;
let server;
let origin;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  workDir = mkdtempSync(join(tmpdir(), 'voice-press-'));
  const script = join(workDir, 'fixture.js');
  const build = spawnSync('bun', [
    'build', '--production', '--format=iife',
    'tests/browser/voice-press-fixture.tsx',
    '--outfile', script,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  // A loopback origin is a secure context, which getUserMedia requires.
  const files = {
    '/': ['text/html', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>'],
    '/fixture.js': ['text/javascript', readFileSync(script, 'utf8')],
    '/styles.css': ['text/css', readFileSync(join(root, 'src/react/styles.css'), 'utf8')],
  };
  server = createServer((request, response) => {
    const file = files[request.url ?? '/'];
    if (!file) {
      // The favicon request must not show up as a console error.
      response.writeHead(request.url === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': file[0] }).end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const COMPOSERS = [
  { label: 'default composer, 375px', kind: 'default', width: 375 },
  { label: 'default composer, 1280px', kind: 'default', width: 1280 },
  { label: 'providers composer, 375px', kind: 'providers', width: 375 },
];

async function openComposer({ kind, width }, { touch, voice } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 812 },
    hasTouch: touch === true,
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(origin);
  await page.evaluate(([composer, config]) => window.mountVoiceComposer(composer, config), [kind, voice]);
  const mic = page.getByRole('button', { name: 'mic', exact: true });
  await mic.waitFor();
  return { context, page, mic, errors, kind };
}

const state = (page) => page
  .locator('[data-component="voice-input-addon"]')
  .getAttribute('data-state');
const harness = (page) => page.evaluate(() => ({
  streams: window.harness.streamCount(),
  live: window.harness.liveTrackCount(),
  maxLive: window.harness.maxConcurrentLiveTracks(),
  sent: window.harness.sent,
}));
const draft = (page, kind) => (kind === 'providers'
  ? page.locator('[data-element="editor"]').textContent()
  : page.locator('textarea').inputValue());
const waitForState = (page, wanted) => page
  .locator(`[data-component="voice-input-addon"][data-state="${wanted}"]`)
  .waitFor({ timeout: 5_000 });

async function centre(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real finger: touchStart, hold, touchEnd (optionally dragged elsewhere). */
async function touchHold(context, page, point, { holdMs, releaseAt } = {}) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo wel' }).waitFor();
  await delay(holdMs);
  if (releaseAt) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [releaseAt] });
    await delay(50);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

describe('mic button gestures in Chrome with a fake microphone', () => {
  for (const composer of COMPOSERS) {
    test(`touch tap starts recording and keeps it on until stopped (${composer.label})`, async () => {
      const { context, page, mic, errors, kind } = await openComposer(composer, { touch: true });
      try {
        await mic.tap();
        await waitForState(page, 'recording');
        await delay(SETTLE_MS);
        assert.equal(await state(page), 'recording', 'the click of the tap must not stop the recording');
        assert.deepEqual(await harness(page), { streams: 1, live: 1, maxLive: 1, sent: [] });

        await page.locator('[data-element="stop-button"]').tap();
        await waitForState(page, 'idle');
        await delay(SETTLE_MS);
        assert.deepEqual(await harness(page), { streams: 1, live: 0, maxLive: 1, sent: [] });
        assert.match(await draft(page, kind), /Hallo Welt/);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test(`touch hold records until release and does not restart (${composer.label})`, async () => {
      const { context, page, mic, errors, kind } = await openComposer(composer, { touch: true });
      try {
        await touchHold(context, page, await centre(mic), { holdMs: HOLD_MS });
        await delay(SETTLE_MS);
        assert.equal(await state(page), 'idle', 'the release must not start a second recording');
        assert.deepEqual(await harness(page), { streams: 1, live: 0, maxLive: 1, sent: [] });
        assert.match(await draft(page, kind), /Hallo Welt/);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test(`mouse hold records until release and does not restart (${composer.label})`, async () => {
      const { context, page, mic, errors, kind } = await openComposer(composer);
      try {
        const point = await centre(mic);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo wel' }).waitFor();
        await delay(HOLD_MS);
        await page.mouse.up();
        await delay(SETTLE_MS);
        assert.equal(await state(page), 'idle', 'the click after the release must not start a second recording');
        assert.deepEqual(await harness(page), { streams: 1, live: 0, maxLive: 1, sent: [] });
        assert.match(await draft(page, kind), /Hallo Welt/);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test(`mouse click toggles recording on and off (${composer.label})`, async () => {
      const { context, page, mic, errors, kind } = await openComposer(composer);
      try {
        await mic.click();
        await waitForState(page, 'recording');
        await delay(SETTLE_MS);
        assert.equal(await state(page), 'recording');
        assert.deepEqual(await harness(page), { streams: 1, live: 1, maxLive: 1, sent: [] });
        await page.locator('[data-element="stop-button"]').click();
        await waitForState(page, 'idle');
        assert.deepEqual(await harness(page), { streams: 1, live: 0, maxLive: 1, sent: [] });
        assert.match(await draft(page, kind), /Hallo Welt/);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  test('a touch hold released away from the mic leaves the next keyboard activation working', async () => {
    const { context, page, mic, errors } = await openComposer(COMPOSERS[2], { touch: true });
    try {
      await touchHold(context, page, await centre(mic), {
        holdMs: HOLD_MS,
        releaseAt: { x: 8, y: 8 },
      });
      await waitForState(page, 'idle');
      await delay(SETTLE_MS);
      assert.deepEqual(await harness(page), { streams: 1, live: 0, maxLive: 1, sent: [] });

      // No pointer is involved: Enter on the focused mic is a lone click.
      await mic.focus();
      await page.keyboard.press('Enter');
      await waitForState(page, 'recording');
      assert.deepEqual(await harness(page), { streams: 2, live: 1, maxLive: 1, sent: [] });
      await page.locator('[data-element="stop-button"]').click();
      await waitForState(page, 'idle');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test('touch tap with push-to-talk off toggles recording on', async () => {
    const { context, page, mic, errors } = await openComposer(COMPOSERS[0], {
      touch: true,
      voice: { pushToTalk: false },
    });
    try {
      await mic.tap();
      await waitForState(page, 'recording');
      await delay(SETTLE_MS);
      assert.equal(await state(page), 'recording');
      assert.deepEqual(await harness(page), { streams: 1, live: 1, maxLive: 1, sent: [] });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
