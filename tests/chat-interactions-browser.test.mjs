import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `@` entities and `/` commands with the keyboard only, in real Chrome, once
// in the React chat and once in <glirastes-chat> (shadow DOM): same keys,
// same ARIA, same messages. No model and no network: the transport records.
// Run: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome \
//   node --test tests/chat-interactions-browser.test.mjs
const root = fileURLToPath(new URL('..', import.meta.url));

let workDir;
let server;
let origin;
let browser;

before(async () => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module (not downloaded implicitly)');
  workDir = mkdtempSync(join(tmpdir(), 'chat-interactions-'));
  // --outdir: the panel imports styles.css, so Bun emits a stylesheet next to the script.
  const build = spawnSync('bun', [
    'build', '--production', '--format=iife',
    'tests/browser/chat-interactions-fixture.tsx',
    '--outdir', workDir,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const script = join(workDir, 'chat-interactions-fixture.js');
  const files = {
    '/': ['text/html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body style="margin:0;font:16px/1.5 system-ui,sans-serif"><div id="root"></div><script src="/fixture.js"></script></body></html>'],
    '/fixture.js': ['text/javascript', readFileSync(script, 'utf8')],
    '/styles.css': ['text/css', readFileSync(join(root, 'src/react/styles.css'), 'utf8')],
  };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = files[path];
    if (!file) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': `${file[0]}; charset=utf-8` }).end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** The direct command a sent text carries, or a failed assertion. */
function command(text) {
  const match = /^<!--glirastes:command (\{[^\n]*\})-->\n(.*)$/.exec(text);
  assert.ok(match, `not a direct command: ${text}`);
  return { ...JSON.parse(match[1]), label: match[2] };
}

async function open(view, viewport = { width: 1024, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(`${origin}/?view=${view}`);
  const editor = page.getByRole('textbox', { name: 'Type a message...' });
  await editor.waitFor();
  const sent = () => page.evaluate(() => window.interactionsHarness.sent);
  const waitForSent = (count) => page.waitForFunction((wanted) => window.interactionsHarness.sent.length === wanted, count);
  /** The editor's `aria-activedescendant`, resolved inside the editor's own tree (document or shadow root). */
  const active = () => editor.evaluate((node) => {
    const id = node.getAttribute('aria-activedescendant');
    const option = id ? node.getRootNode().getElementById(id) : null;
    if (!option) return null;
    const text = option.getAttribute('aria-label') ?? option.querySelector('[data-element="label"]')?.textContent ?? option.textContent;
    return { text, selected: option.getAttribute('aria-selected') };
  });
  /** Focus moves back to the editor once the form is gone; give React that render. */
  const editorFocused = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await editor.evaluate((node) => node.getRootNode().activeElement === node)) return true;
      await page.waitForTimeout(50);
    }
    return false;
  };
  return { page, editor, errors, sent, waitForSent, active, editorFocused, close: () => context.close() };
}

for (const view of ['react', 'embed']) {
  describe(`chat interactions by keyboard (${view})`, () => {
    test('a / command runs alone, with listbox semantics the editor controls', async () => {
      const { page, editor, errors, sent, waitForSent, active, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/');
        const listbox = page.getByRole('listbox', { name: 'Suggestions' });
        await listbox.waitFor();
        assert.deepEqual(await listbox.getByRole('option').allTextContents(), ['Assign', 'Filter Tasks', 'Open Overview']);
        assert.equal(await editor.getAttribute('aria-controls'), await listbox.getAttribute('id'));
        assert.equal(await editor.getAttribute('aria-autocomplete'), 'list');
        assert.deepEqual(await active(), { text: 'Assign', selected: 'true' });
        assert.equal(await page.getByRole('status').textContent(), '3 suggestions');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.deepEqual(await active(), { text: 'Open Overview', selected: 'true' });
        await page.keyboard.press('Enter');
        assert.equal(await listbox.count(), 0);
        assert.equal(await editor.getAttribute('aria-activedescendant'), null);
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview',
        });
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('an @ entity action is reached with ArrowRight and runs with Enter', async () => {
      const { page, editor, errors, sent, waitForSent, active, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        assert.deepEqual(await active(), { text: 'Release prüfen', selected: 'true' });
        await page.keyboard.press('ArrowRight');
        assert.deepEqual(await active(), { text: 'Complete: Release prüfen', selected: 'true' });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowLeft');
        assert.deepEqual(await active(), { text: 'Complete: Release prüfen', selected: 'true' });
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' }, label: '/Complete @Release prüfen',
        });
        assert.equal(await editor.textContent(), '');
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('missing arguments are asked for in a form and the command then runs', async () => {
      const { page, editor, errors, sent, waitForSent, editorFocused, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/filter');
        await page.getByRole('option', { name: 'Filter Tasks' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const filterForm = page.getByRole('form', { name: 'Details for Filter Tasks' });
        await filterForm.waitFor();
        const status = filterForm.getByRole('combobox', { name: 'Status' });
        assert.equal(await status.evaluate((node) => node.getRootNode().activeElement === node), true);
        await page.keyboard.press('d');
        assert.equal(await status.inputValue(), 'done');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'filter.tasks', tool: 'ui.filter.tasks', args: { status: 'done' }, label: '/Filter Tasks done',
        });
        assert.equal(await filterForm.count(), 0);
        assert.equal(await editorFocused(), true);

        await page.keyboard.type('/assign');
        await page.getByRole('option', { name: 'Assign' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const assignForm = page.getByRole('form', { name: 'Details for Assign' });
        await assignForm.waitFor();
        const person = assignForm.getByRole('combobox', { name: 'Person *' });
        assert.equal(await person.evaluate((node) => node.getRootNode().activeElement === node), true);
        await page.keyboard.type('ali');
        await assignForm.getByRole('option', { name: 'Alice Example' }).waitFor();
        assert.equal(await person.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Enter');
        assert.equal(await person.inputValue(), 'Alice Example');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await waitForSent(2);
        assert.deepEqual(command((await sent())[1]), {
          commandId: 'tasks.assign', tool: 'tasks.assign', args: { taskId: '7', assignee: 'alice' },
          label: '/Assign @Release prüfen @Alice Example',
        });
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });
  });

  // Carried from the Task 10-12 reviews: what only real Chrome can prove (the
  // mouse inside a shadow root, focus and Escape in the form, layout).
  describe(`chat interactions by mouse, validation and layout (${view})`, () => {
    test('an @ entity action is picked with the mouse and the @query is gone', async () => {
      const { page, editor, errors, sent, waitForSent, editorFocused, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        await page.getByRole('option', { name: 'Complete: Release prüfen' }).click();
        await waitForSent(1);
        assert.deepEqual(command((await sent())[0]), {
          commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' }, label: '/Complete @Release prüfen',
        });
        assert.equal(await editor.textContent(), '');
        assert.equal(await page.getByRole('listbox', { name: 'Suggestions' }).count(), 0);
        assert.equal(await editorFocused(), true);
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('Run names a missing or unpicked person and keeps focus there, Escape then cancels', async () => {
      const { page, editor, errors, sent, editorFocused, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/assign');
        await page.getByRole('option', { name: 'Assign' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const form = page.getByRole('form', { name: 'Details for Assign' });
        await form.waitFor();
        const person = form.getByRole('combobox', { name: 'Person *' });
        const personFocused = () => person.evaluate((node) => node.getRootNode().activeElement === node);
        assert.equal(await personFocused(), true);

        // Nothing entered: Run names the field instead of sending a command without it.
        await form.getByRole('button', { name: 'Run' }).click();
        assert.equal(await form.getByRole('alert').textContent(), 'Please complete: Person');
        assert.equal(await person.getAttribute('aria-invalid'), 'true');
        assert.equal(await personFocused(), true);

        // Text that was typed but never picked is refused the same way and stays in the box.
        await page.keyboard.type('ali');
        await form.getByRole('option', { name: 'Alice Example' }).waitFor();
        await form.getByRole('button', { name: 'Run' }).click();
        assert.equal(await form.getByRole('alert').textContent(), 'Please complete: Person');
        assert.equal(await person.inputValue(), 'ali');
        assert.equal(await personFocused(), true);
        assert.deepEqual(await sent(), []);

        // The first Escape closes the list the focus brought back, the second cancels the form.
        await form.getByRole('option', { name: 'Alice Example' }).waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await person.getAttribute('aria-expanded'), 'false');
        assert.equal(await form.count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await form.count(), 0);
        assert.equal(await editorFocused(), true);
        assert.deepEqual(await sent(), []);
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    test('Escape in a form without a visible list cancels it at once', async () => {
      const { page, editor, errors, sent, editorFocused, close } = await open(view);
      try {
        await editor.click();
        await page.keyboard.type('/filter');
        await page.getByRole('option', { name: 'Filter Tasks' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const form = page.getByRole('form', { name: 'Details for Filter Tasks' });
        await form.waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await form.count(), 0);
        assert.equal(await editorFocused(), true);

        // "No matches" shows no list either: Escape cancels at once there as well.
        await page.keyboard.type('/assign');
        await page.getByRole('option', { name: 'Assign' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('@rel');
        await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        const assignForm = page.getByRole('form', { name: 'Details for Assign' });
        await assignForm.waitFor();
        await page.keyboard.type('zzz');
        await assignForm.getByText('No matches').waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await assignForm.count(), 0);
        assert.equal(await editorFocused(), true);
        assert.deepEqual(await sent(), []);
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });

    for (const viewport of [{ width: 1024, height: 800 }, { width: 375, height: 640 }]) {
      test(`the @ list opens above the composer inside the panel at ${viewport.width}px`, async () => {
        const { page, editor, errors, close } = await open(view, viewport);
        try {
          await editor.click();
          await page.keyboard.type('@rel');
          await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
          const panel = await page.locator('[data-component="ai-chat-panel"]').boundingBox();
          const composer = await editor.boundingBox();
          const list = await page.getByRole('listbox', { name: 'Suggestions' }).boundingBox();
          assert.ok(list.y + list.height <= composer.y, 'the list opens upwards, clear of the editor');
          assert.ok(list.x >= panel.x && list.x + list.width <= panel.x + panel.width, 'the list stays inside the panel');
          // The chips stay on one line beside the result, each inside the panel.
          const chips = await page.getByRole('option', { name: /: Release prüfen$/ }).all();
          assert.equal(chips.length, 2);
          const boxes = await Promise.all(chips.map((chip) => chip.boundingBox()));
          assert.ok(boxes.every((box) => Math.abs(box.y - boxes[0].y) < 1), 'the chips share one line');
          assert.ok(boxes.every((box) => box.x >= panel.x && box.x + box.width <= panel.x + panel.width));
          // The description is stacked under the label, not run on after it.
          const label = await page.locator('[data-component="mention-dropdown-item"] [data-element="label"]').first().boundingBox();
          const description = await page.locator('[data-component="mention-dropdown-item"] [data-element="description"]').first().boundingBox();
          assert.ok(description.y >= label.y + label.height - 1, 'description below the label');
          assert.equal(await page.locator('[data-component="ai-chat-panel"]').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      });

      test(`the argument form takes its own row above the composer at ${viewport.width}px`, async () => {
        const { page, editor, errors, close } = await open(view, viewport);
        try {
          await editor.click();
          await page.keyboard.type('/assign');
          await page.getByRole('option', { name: 'Assign' }).waitFor();
          await page.keyboard.press('Enter');
          await page.keyboard.type('@rel');
          await page.getByRole('group', { name: 'Release prüfen' }).waitFor();
          await page.keyboard.press('Enter');
          await page.keyboard.press('Enter');
          const form = page.getByRole('form', { name: 'Details for Assign' });
          await form.waitFor();
          await page.keyboard.type('ali');
          await form.getByRole('option', { name: 'Alice Example' }).waitFor();
          const panel = await page.locator('[data-component="ai-chat-panel"]').boundingBox();
          const composer = await editor.boundingBox();
          const box = await form.boundingBox();
          assert.ok(box.y + box.height <= composer.y, 'the form sits above the editor, not beside it');
          assert.ok(Math.abs(box.x - composer.x) < 1, 'the form starts where the composer starts');
          assert.ok(box.x + box.width >= composer.x + composer.width, 'the form is at least as wide as the editor');
          assert.ok(box.x + box.width <= panel.x + panel.width, 'the form stays inside the panel');
          const list = await form.getByRole('listbox', { name: 'Person' }).boundingBox();
          assert.ok(list.x >= panel.x && list.x + list.width <= panel.x + panel.width, 'the person list stays inside the panel');
          assert.equal(await form.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          assert.equal(await page.locator('[data-component="ai-chat-panel"]').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      });
    }
  });
}
