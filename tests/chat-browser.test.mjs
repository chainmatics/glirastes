import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { startChatHarness } from './browser/harness-server.mjs';

// Real Chrome with a fake microphone: FR-4/FR-5 lifecycle, mobile layout and
// <glirastes-chat>. Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs
// PLAYWRIGHT_CHANNEL=chrome node --test tests/chat-browser.test.mjs
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const HOLD_MS = 450; // longer than the 350 ms hold threshold
const SETTLE_MS = 600;
let harness;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  harness = await startChatHarness();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  await browser?.close();
  await harness?.close();
});

async function openPage(view, viewport = { width: 1280, height: 900 }, { touch = false } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: touch, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`${harness.origin}/?view=${view}`);
  return { page, context, errors, close: () => context.close() };
}

const liveTracks = (page) => page.evaluate(() => window.harness.liveTrackCount());
const streamCount = (page) => page.evaluate(() => window.harness.streamCount());
const waitForNoLiveTrack = (page) =>
  page.waitForFunction(() => window.harness.liveTrackCount() === 0, null, { timeout: 5_000 });
const waitForState = (page, wanted) => page
  .locator(`[data-component="voice-input-addon"][data-state="${wanted}"]`)
  .waitFor({ timeout: 5_000 });
const addonState = (page) => page
  .locator('[data-component="voice-input-addon"]')
  .getAttribute('data-state');

async function startRecording(page) {
  await page.getByRole('button', { name: 'mic', exact: true }).click();
  await page.locator('[data-component="voice-input-addon"][data-state="recording"]').waitFor();
  await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt aus dem browser' }).waitFor();
  assert.equal(await liveTracks(page), 1, 'exactly one live microphone track while recording');
}

async function assertSingleStream(page, errors) {
  assert.equal(await page.evaluate(() => window.harness.maxConcurrentLiveTracks()), 1);
  assert.deepEqual(errors, []);
}

async function centre(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('speech-to-text lifecycle in Chrome with a fake microphone', () => {
  test('stop finalizes into the editable draft without sending and releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await editor.fill('Bitte:');
      await startRecording(page);
      assert.equal(await editor.inputValue(), 'Bitte:', 'interim text must not enter the editor');
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await editor.inputValue(), 'Bitte: Hallo Welt aus dem Browser');
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      await editor.fill('Bitte: Hallo Welt, morgen');
      await editor.press('Enter');
      await page.waitForFunction(() => window.harness.sent.length === 1);
      assert.deepEqual(await page.evaluate(() => window.harness.sent), ['Bitte: Hallo Welt, morgen']);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('cancel keeps the previous draft and releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await editor.fill('Entwurf');
      await startRecording(page);
      await page.locator('[data-element="cancel-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await editor.inputValue(), 'Entwurf');
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('retry after a provider failure records again with one stream at a time', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.evaluate(() => window.harness.failNextConnect());
      await page.getByRole('button', { name: 'mic', exact: true }).click();
      await page.locator('[data-component="voice-input-addon"][data-state="failed"]').waitFor();
      await waitForNoLiveTrack(page);
      await page.getByRole('button', { name: 'Retry recording' }).click();
      await page.locator('[data-component="voice-input-addon"][data-state="recording"]').waitFor();
      assert.equal(await liveTracks(page), 1);
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);
      assert.equal(await page.evaluate(() => window.harness.streamCount()), 2);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  for (const [label, action] of [
    ['a route change', (page) => page.getByRole('button', { name: 'Go to reports' }).click()],
    ['a session switch', (page) => page.getByRole('button', { name: 'Switch session' }).click()],
  ]) {
    test(`${label} stops recording, keeps the speech as draft and releases the mic`, async () => {
      const { page, errors, close } = await openPage('stt');
      try {
        await startRecording(page);
        await action(page);
        await waitForNoLiveTrack(page);
        assert.match(
          await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
          /Hallo Welt aus dem Browser/,
        );
        await assertSingleStream(page, errors);
      } finally {
        await close();
      }
    });
  }

  test('browser back navigation releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.getByRole('button', { name: 'Go to reports' }).click();
      await startRecording(page);
      await page.goBack();
      await waitForNoLiveTrack(page);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('unmounting the chat releases the mic', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await startRecording(page);
      await page.getByRole('button', { name: 'Unmount chat' }).click();
      await waitForNoLiveTrack(page);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('push-to-talk: holding the button records until release', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      const mic = page.getByRole('button', { name: 'mic', exact: true });
      const box = await mic.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt' }).waitFor();
      await delay(HOLD_MS);
      await page.mouse.up();
      await waitForNoLiveTrack(page);
      // The click that follows the release must neither restart nor stop anything.
      await delay(SETTLE_MS);
      assert.equal(await addonState(page), 'idle', 'the click after the release must not start a second recording');
      assert.equal(await streamCount(page), 1);
      assert.equal(
        await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
        'Hallo Welt aus dem Browser',
      );
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('push-to-talk: holding the hotkey records until release', async () => {
    const { page, errors, close } = await openPage('stt');
    try {
      await page.getByRole('textbox', { name: 'Type a message...' }).focus();
      await page.keyboard.down(MOD);
      await page.keyboard.down('Shift');
      await page.keyboard.down('Space');
      await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt' }).waitFor();
      await page.keyboard.up('Space');
      await page.keyboard.up('Shift');
      await page.keyboard.up(MOD);
      await waitForNoLiveTrack(page);
      assert.equal(
        await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
        'Hallo Welt aus dem Browser',
      );
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('touch tap starts recording and keeps it on until stopped', async () => {
    const { page, errors, close } = await openPage('stt', undefined, { touch: true });
    try {
      const mic = page.getByRole('button', { name: 'mic', exact: true });
      await mic.tap();
      await waitForState(page, 'recording');
      await delay(SETTLE_MS);
      assert.equal(await addonState(page), 'recording', 'the click of the tap must not stop the recording');
      assert.equal(await streamCount(page), 1);
      assert.equal(await liveTracks(page), 1);
      await page.locator('[data-element="stop-button"]').tap();
      await waitForState(page, 'idle');
      await waitForNoLiveTrack(page);
      assert.equal(await streamCount(page), 1);
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      assert.equal(
        await page.getByRole('textbox', { name: 'Type a message...' }).inputValue(),
        'Hallo Welt aus dem Browser',
      );
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });

  test('touch hold records until release and does not restart', async () => {
    const { page, context, errors, close } = await openPage('stt', undefined, { touch: true });
    try {
      const point = await centre(page.getByRole('button', { name: 'mic', exact: true }));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.locator('[data-part="interim-transcript"]', { hasText: 'hallo welt' }).waitFor();
      await delay(HOLD_MS);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitForNoLiveTrack(page);
      await delay(SETTLE_MS);
      assert.equal(await addonState(page), 'idle', 'the release must not start a second recording');
      assert.equal(await streamCount(page), 1);
      assert.equal(await liveTracks(page), 0);
      assert.deepEqual(await page.evaluate(() => window.harness.sent), []);
      await assertSingleStream(page, errors);
    } finally {
      await close();
    }
  });
});

describe('mobile layout (375 × 812)', () => {
  test('chat, clarification, commands and recording stay inside the viewport', async () => {
    const { page, errors, close } = await openPage('mobile', { width: 375, height: 812 });
    try {
      const inside = async (locator, label) => {
        const box = await locator.boundingBox();
        assert.ok(box, `${label} is not rendered`);
        assert.ok(box.x >= 0 && box.x + box.width <= 375.5, `${label} overflows horizontally`);
        assert.ok(box.y >= 0 && box.y + box.height <= 812.5, `${label} overflows vertically`);
      };
      const panel = page.locator('[data-component="chat-window"]');
      await page.locator('[data-component="clarification-card"]').waitFor();
      const panelBox = await panel.boundingBox();
      assert.equal(Math.round(panelBox.width), 375);
      assert.equal(Math.round(panelBox.height), 812);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'page scrolls horizontally');

      const card = page.locator('[data-component="clarification-card"]');
      await inside(card, 'clarification card');
      for (const option of await card.locator('[data-action="answer-option"]').all()) {
        await inside(option, 'clarification option');
      }
      assert.ok(await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));

      const editor = page.getByRole('textbox', { name: 'Type a message...' });
      await inside(editor, 'composer');
      await inside(page.getByRole('button', { name: 'mic', exact: true }), 'mic button');
      // One composer row: the editor keeps more than half the panel and the mic sits beside it.
      const editorBox = await editor.boundingBox();
      const micBox = await page.getByRole('button', { name: 'mic', exact: true }).boundingBox();
      assert.ok(editorBox.width > panelBox.width / 2, `editor is squeezed to ${editorBox.width}px`);
      assert.ok(micBox.x >= editorBox.x + editorBox.width - 0.5, 'mic must sit right of the editor');
      assert.ok(
        micBox.y < editorBox.y + editorBox.height && editorBox.y < micBox.y + micBox.height,
        'editor and mic must share a row',
      );
      await editor.click();
      await page.keyboard.type('/erl');
      const dropdown = page.locator('[data-component="mention-dropdown"]');
      await dropdown.waitFor();
      await inside(dropdown, 'command list');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      assert.equal(await editor.evaluate((node) => node.textContent), '', 'the command text must be cleared');

      await startRecording(page);
      const bar = page.locator('[data-component="recording-bar"]');
      await inside(bar, 'recording bar');
      // The transcript stays readable: not squeezed, and its newest words are not clipped.
      const transcript = page.locator('[data-part="interim-transcript"]');
      assert.ok((await transcript.boundingBox()).width >= 100, 'interim transcript is squeezed');
      assert.ok(await transcript.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'interim transcript is clipped');
      const barBox = await bar.boundingBox();
      const recordingEditorBox = await editor.boundingBox();
      assert.ok(
        barBox.y >= recordingEditorBox.y + recordingEditorBox.height - 0.5
          || barBox.x >= recordingEditorBox.x + recordingEditorBox.width - 0.5,
        'recording bar overlaps the editor',
      );
      await page.locator('[data-element="stop-button"]').click();
      await waitForNoLiveTrack(page);

      await card.getByRole('button', { name: 'Release prüfen' }).click();
      await page.waitForFunction(() => window.harness.sent.length === 1);
      assert.match(
        (await page.evaluate(() => window.harness.sent))[0],
        /^<!--glirastes:clarification \{"toolCallId":"call-1","optionId":"task-2"\}-->\nRelease prüfen$/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
});

describe('<glirastes-chat> in a plain page', () => {
  test('renders in shadow DOM, takes host CSS variables, sends by keyboard and unmounts cleanly', async () => {
    const { page, errors, close } = await openPage('embed');
    try {
      const textarea = page.locator('glirastes-chat textarea');
      await textarea.waitFor();
      assert.equal(await textarea.getAttribute('placeholder'), 'Frag deine App');
      const primary = await page.evaluate(() => {
        const host = document.querySelector('glirastes-chat');
        const panel = host.shadowRoot.querySelector('[data-component="ai-chat-panel"]');
        return getComputedStyle(panel).getPropertyValue('--cm-primary').trim();
      });
      assert.equal(primary, '#10b981');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-component="ai-chat-panel"]').length), 0,
        'the chat must live in the shadow root only');

      await textarea.focus();
      await page.keyboard.type('Zeige meine Aufgaben');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.harness.sent.includes('Zeige meine Aufgaben'));
      const types = await page.evaluate(() => window.harness.events.map((event) => event.type));
      assert.ok(types.includes('glirastes-chat:ready'));

      const remaining = await page.evaluate(async () => {
        const host = document.querySelector('glirastes-chat');
        host.remove();
        await new Promise((done) => setTimeout(done, 0));
        return host.shadowRoot.childNodes.length;
      });
      assert.equal(remaining, 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
});
