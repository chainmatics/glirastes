import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// FR-5 "sichtbarer Interim-Text" needs real layout: jsdom cannot tell a 14px
// clipped box from a readable one. Real Chrome renders the shipped styles.css
// and the real RecordingBar at the widths that matter.
// Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome \
//   node --test tests/recording-bar-browser.test.mjs
const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_TEXT = 'hallo welt aus dem browser';
const LONG_TEXT = `${'alt '.repeat(40)}neueste Worte`;
const ARABIC_TEXT = 'قديم '.repeat(40) + 'أحدث الكلمات';

let workDir;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  workDir = mkdtempSync(join(tmpdir(), 'recording-bar-'));
  const build = spawnSync('bun', [
    'build', '--production', '--format=iife',
    'tests/browser/recording-bar-fixture.tsx',
    '--outfile', join(workDir, 'fixture.js'),
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
});

after(async () => {
  await browser?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Mounts the recording composer at a viewport width and measures it. */
async function measure(width, transcript) {
  const context = await browser.newContext({ viewport: { width, height: 812 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><div id="root"></div></body></html>');
    await page.addStyleTag({ path: join(root, 'src/react/styles.css') });
    await page.addScriptTag({ path: join(workDir, 'fixture.js') });
    await page.evaluate((text) => window.mountComposer(text), transcript);
    await page.locator('[data-part="interim-transcript"]').waitFor();
    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      };
      const interim = document.querySelector('[data-part="interim-transcript"]');
      const range = document.createRange();
      range.selectNodeContents(interim);
      const text = range.getBoundingClientRect();
      return {
        docScrollWidth: document.documentElement.scrollWidth,
        editor: box('[data-element="editor"]'),
        send: box('[data-action="send"]'),
        bar: box('[data-component="recording-bar"]'),
        interim: box('[data-part="interim-transcript"]'),
        text: { left: text.left, right: text.right },
        interimScrollWidth: interim.scrollWidth,
        interimClientWidth: interim.clientWidth,
      };
    });
    assert.deepEqual(errors, []);
    return layout;
  } finally {
    await context.close();
  }
}

describe('interim transcript in the recording bar (real Chrome, shipped styles.css)', () => {
  test('375px: the bar has its own row and a readable transcript slot', async () => {
    const layout = await measure(375, FIXTURE_TEXT);
    assert.ok(layout.docScrollWidth <= 375, 'page scrolls horizontally');
    assert.ok(layout.bar.left >= 0 && layout.bar.right <= 375.5, 'recording bar leaves the viewport');
    assert.ok(layout.bar.top >= layout.editor.bottom - 1, 'bar shares the editor row and starves the text');
    assert.ok(layout.send.bottom <= layout.bar.top + 1, 'Send drops below the editor with the bar');
    assert.ok(layout.editor.width >= 150, `editor starved to ${layout.editor.width}px`);
    assert.ok(layout.interim.width >= 100, `transcript slot is only ${layout.interim.width}px wide`);
    assert.ok(layout.interimScrollWidth <= layout.interimClientWidth + 1,
      `"${FIXTURE_TEXT}" needs ${layout.interimScrollWidth}px of ${layout.interimClientWidth}px`);
  });

  test('375px: a long transcript keeps its newest words and clips the oldest', async () => {
    const layout = await measure(375, LONG_TEXT);
    assert.ok(layout.interim.width >= 100);
    assert.ok(layout.text.right <= layout.interim.right + 1 && layout.text.right >= layout.interim.right - 8,
      `the end of the text sits at ${layout.text.right}, the slot ends at ${layout.interim.right}`);
    assert.ok(layout.text.left < layout.interim.left, 'the oldest words should be the clipped side');
  });

  test('1280px: a long transcript fits whole into the wide slot', async () => {
    const layout = await measure(1280, LONG_TEXT);
    assert.ok(layout.text.left >= layout.interim.left - 1 && layout.text.right <= layout.interim.right + 1,
      `the text spans ${layout.text.left}-${layout.text.right}, the slot ${layout.interim.left}-${layout.interim.right}`);
  });

  test('375px: a right-to-left script keeps its newest words visible on the left', async () => {
    const layout = await measure(375, ARABIC_TEXT);
    assert.ok(layout.text.left >= layout.interim.left - 1 && layout.text.left <= layout.interim.left + 8,
      `the end of the text sits at ${layout.text.left}, the slot starts at ${layout.interim.left}`);
    assert.ok(layout.text.right > layout.interim.right, 'the oldest words should be the clipped side');
  });
});
