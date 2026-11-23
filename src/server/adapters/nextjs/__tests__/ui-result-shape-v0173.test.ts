import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UiActionBus } from '../../../../browser/ui-action-bus.js';
import { uiActionToolToTool, uiToolToTool } from '../../../core/index.js';
import { defineUiTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { dispatchToolResultUiActions, hasSuccessfulResultV0173 } from './ui-result-shape-v0173/client-v0173.js';
import { CASES, runAll, runCase, type CaseRecord, type ScenarioSdk } from './ui-result-shape-v0173/scenario.js';

/**
 * A 0.17 browser against this server: requests without `glirastesUiOutcomes`
 * get exactly what 0.17.3 sent. `golden-0.17.3.json` was recorded from the
 * published glirastes 0.17.3 package (`ui-result-shape-v0173/record.ts`).
 */
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'ui-result-shape-v0173/golden-0.17.3.json'), 'utf8')) as {
  sdk: string;
  records: Record<string, CaseRecord>;
};

const sdk = {
  createAiChatHandler,
  uiActionToolToTool,
  uiToolToTool,
  defineUiTool,
  z,
  MockLanguageModelV3,
  convertArrayToReadableStream,
} as unknown as ScenarioSdk;

type Json = Record<string, unknown>;

function toolOutput(record: CaseRecord): Json {
  const chunk = record.chunks.find((entry) => entry.type === 'tool-output-available');
  expect(chunk).toBeDefined();
  return chunk!.output as Json;
}

/**
 * A record in the form the golden test compares. 0.17.3 wrote
 * `data-step-report` next to the model's merged stream, so the golden has
 * it where the scheduler put it; it now comes right before its step's
 * `finish-step` (`side-part-order.test.ts`). Every other
 * chunk is compared in exact order, the step reports in their own order,
 * every chunk byte for byte.
 */
function comparable(record: CaseRecord): string {
  const isReport = (chunk: Json) => chunk.type === 'data-step-report';
  return JSON.stringify({
    chunks: record.chunks.filter((chunk) => !isReport(chunk)),
    stepReports: record.chunks.filter(isReport),
    modelToolResults: record.modelToolResults,
  });
}

describe('UI tool results for a client without the outcome flag (0.17.3 compatibility)', () => {
  it('golden: the stream and the model input of a UI tool turn equal glirastes 0.17.3, byte for byte', async () => {
    expect(golden.sdk).toBe('glirastes@0.17.3');
    const records = await runAll(sdk);
    expect(Object.keys(records)).toEqual(CASES.map((entry) => entry.name));
    for (const entry of CASES) {
      expect(comparable(records[entry.name]!), entry.name).toBe(comparable(golden.records[entry.name]!));
    }
  });

  it('golden: a request without the flag that names its language (Content-Language) keeps the 0.17.3 shape', async () => {
    // The language is no outcome flag: the result shape follows glirastesUiOutcomes alone. These turns carry no
    // language-dependent text (no tool labels, no handler text), so the stream stays byte-identical in every language.
    for (const language of ['pl', 'de-AT', 'en']) {
      const records = await runAll(sdk, {}, { 'content-language': language });
      for (const entry of CASES) {
        expect(comparable(records[entry.name]!), `${language} ${entry.name}`).toBe(comparable(golden.records[entry.name]!));
      }
    }
  });

  it("golden: uiToolResultShape: 'legacy' gives the same stream", async () => {
    const records = await runAll(sdk, { uiToolResultShape: 'legacy' });
    for (const entry of CASES) {
      expect(comparable(records[entry.name]!), entry.name).toBe(comparable(golden.records[entry.name]!));
    }
  });

  it('golden: the comparison still sees every chunk (the hand-off shape differs)', async () => {
    const records = await runAll(sdk, { uiToolResultShape: 'handoff' });
    expect(comparable(records[CASES[0]!.name]!)).not.toBe(comparable(golden.records[CASES[0]!.name]!));
  });

  it('a 0.17.3 browser runs the generated UI actions of a 0.18 server (its own dispatch rule)', async () => {
    const records = await runAll(sdk);
    for (const entry of CASES.filter((call) => call.toolName !== 'ui_open_task')) {
      const bus = new UiActionBus();
      const ran: Array<{ type: string; actionId?: string }> = [];
      // The open page: the navigation bridge and the client action it offers.
      bus.subscribeById('glirastes.navigate', (action) => { ran.push(action); });
      bus.subscribeById('tasks.refresh', (action) => { ran.push(action); });
      if (entry.toolName === 'ui_archive_task') {
        // The page-bound action registers once its route is open.
        bus.subscribeById('glirastes.navigate', () => {
          setTimeout(() => bus.subscribeById('tasks.archive', (action) => { ran.push(action); }), 0);
        });
      }
      const output = toolOutput(records[entry.name]!);
      const dispatched = await dispatchToolResultUiActions(output, bus, { routeTimeoutMs: 1_000 });
      expect(dispatched, entry.name).toBe(1);
      const expected = (output.uiAction as { actionId: string }).actionId;
      expect(ran.map((action) => action.actionId), entry.name).toContain(expected);
    }
  });

  it("a 0.17.3 app's onToolResult still sees a successful hand-written UI tool result", async () => {
    const record = await runCase(sdk, CASES.find((call) => call.toolName === 'ui_open_task')!);
    const output = toolOutput(record);
    expect(hasSuccessfulResultV0173(output)).toBe(true);
    expect(output.uiAction).toEqual({ type: 'open-dialog', dialog: 'task', taskId: 't1' });
  });

  it("with uiToolResultShape: 'handoff' a 0.17.3 browser runs nothing (the explicit override)", async () => {
    const record = await runCase(sdk, CASES[0]!, { uiToolResultShape: 'handoff' });
    const output = toolOutput(record);
    expect(output).toMatchObject({ handedOff: true });
    expect(output).not.toHaveProperty('success');
    expect(await dispatchToolResultUiActions(output, new UiActionBus())).toBe(0);
  });

  it('the copied 0.17.3 dispatch rule matches the tag (when the tag is available)', () => {
    let source: string;
    let handler: string;
    try {
      source = execFileSync('git', ['show', 'v0.17.3:src/browser/client-actions.ts'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      handler = execFileSync('git', ['show', 'v0.17.3:src/react/utils/create-tool-result-handler.ts'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return; // A clone without tags (CI checkout): the copy was taken from the tag.
    }
    const copy = readFileSync(join(here, 'ui-result-shape-v0173/client-v0173.ts'), 'utf8');
    const lines = (text: string, from: number, to: number) => text.split('\n').slice(from - 1, to).join('\n');
    expect(copy).toContain(lines(source, 55, 133).replace(
      'export async function dispatchToolResultUiActions',
      'export async function dispatchToolResultUiActions',
    ));
    expect(copy).toContain(lines(handler, 20, 23)
      .replace('function hasSuccessfulResult(', 'export function hasSuccessfulResultV0173(')
      .replace('isRecord(result.data)', 'isHandlerRecord(result.data)'));
    expect(copy).toContain(lines(handler, 8, 10).replace('function isRecord(', 'function isHandlerRecord('));
  });
});
