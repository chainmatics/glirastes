import { describe, expect, it } from 'vitest';
import { readActivitySteps } from './activity.js';

describe('readActivitySteps', () => {
  it('hides SDK built-ins such as find_tools and read_result, keeps app tools', () => {
    const parts = [
      { type: 'tool-find_tools', toolCallId: 'c1', state: 'output-available', output: {} },
      { type: 'tool-tasks_list', toolCallId: 'c2', state: 'output-available', output: {} },
      { type: 'tool-read_result', toolCallId: 'c3', state: 'output-available', output: {} },
      { type: 'dynamic-tool', toolName: 'read_result', toolCallId: 'c4', state: 'output-available', output: {} },
    ];
    expect(readActivitySteps(parts, () => false).map((step) => step.toolName)).toEqual(['tasks_list']);
  });

  it('reads a declined approval as declined, not as an error', () => {
    const parts = [
      { type: 'tool-tasks_delete', toolCallId: 'c1', state: 'output-denied', approval: { id: 'a1', approved: false } },
      { type: 'tool-tasks_list', toolCallId: 'c2', state: 'output-error', errorText: 'boom' },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([
      ['declined', undefined],
      ['error', 'boom'],
    ]);
  });

  it('reads an output with success: false and no expectedFailure marker as a failed step, with its error text', () => {
    const parts = [
      // Endpoint tool: a backend failure arrives as an output, not as output-error.
      { type: 'tool-tasks_get', toolCallId: 'c1', state: 'output-available', output: { success: false, error: 'Not found', status: 404, retryable: false } },
      // Not classified by the app (or produced by a server before classifyToolFailure): a failure.
      { type: 'tool-tasks_lock', toolCallId: 'c2', state: 'output-available', output: { success: false, error: 'Locked', status: 409 } },
      // Generated UI tool refused on the server.
      { type: 'tool-ui_dialog_open', toolCallId: 'c3', state: 'output-available', output: { success: false, error: 'Not on this page.', retryable: false } },
      // Custom tool without an error text.
      { type: 'dynamic-tool', toolName: 'custom', toolCallId: 'c4', state: 'output-available', output: { success: false } },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([
      ['error', 'Not found'],
      ['error', 'Locked'],
      ['error', 'Not on this page.'],
      ['error', undefined],
    ]);
    expect(readActivitySteps(parts, () => false).map((step) => [step.status, step.detail])).toEqual([
      ['error', undefined], ['error', undefined], ['error', undefined], ['error', undefined],
    ]);
  });

  it('keeps other outputs done: success true, no success field, non-object outputs', () => {
    const parts = [
      { type: 'tool-a', toolCallId: 'c1', state: 'output-available', output: { success: true, message: 'Saved' } },
      { type: 'tool-b', toolCallId: 'c2', state: 'output-available', output: { items: [] } },
      { type: 'tool-c', toolCallId: 'c3', state: 'output-available', output: 'plain text' },
      { type: 'tool-d', toolCallId: 'c4', state: 'output-available', output: [{ success: false }] },
      { type: 'tool-e', toolCallId: 'c5', state: 'output-available', output: null },
      { type: 'tool-f', toolCallId: 'c6', state: 'output-available', output: { success: 'false', error: 'x' } },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([
      ['done', 'Saved'],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
    ]);
  });

  it('does not show the model-facing hand-off note of a UI tool as step detail', () => {
    const parts = [
      { type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available', output: {
        success: true,
        message: 'Handed to the app. Whether it was carried out is not known: do not tell the user it succeeded, say it was requested and should now be visible. Do not repeat the call. Do not quote this text.',
        uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks' } },
      } },
      { type: 'tool-ui_open', toolCallId: 'c2', state: 'output-available', output: {
        success: true,
        message: 'Handed to the app, which opens /templates to run the action there. Whether it was carried out is not known: do not tell the user it succeeded, say it was requested and should now be visible. Do not repeat the call. Do not quote this text.',
      } },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([
      ['done', undefined],
      ['done', undefined],
    ]);
  });

  it('reads a failure classifyToolFailure marked as expected as its own neutral step, with its error text', () => {
    const parts = [
      { type: 'tool-tasks_get', toolCallId: 'c1', state: 'output-available', output: { success: false, error: 'Not found', status: 404, retryable: false, expectedFailure: true } },
      { type: 'tool-tasks_delete', toolCallId: 'c2', state: 'output-available', output: { success: false, error: 'Forbidden', status: 403, retryable: false, expectedFailure: true } },
      // Only the boolean marker next to success: false counts.
      { type: 'tool-tasks_lock', toolCallId: 'c3', state: 'output-available', output: { success: false, error: 'Locked', expectedFailure: 'true' } },
      { type: 'tool-tasks_list', toolCallId: 'c4', state: 'output-available', output: { success: true, expectedFailure: true } },
      // A thrown error stays a failure whatever its output says.
      { type: 'tool-tasks_sync', toolCallId: 'c5', state: 'output-error', errorText: 'boom', output: { success: false, expectedFailure: true } },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([
      ['expected', 'Not found'],
      ['expected', 'Forbidden'],
      ['error', 'Locked'],
      ['done', undefined],
      ['error', 'boom'],
    ]);
    expect(readActivitySteps(parts, () => false).map((step) => [step.status, step.detail])).toEqual([
      ['expected', undefined], ['expected', undefined], ['error', undefined], ['done', undefined], ['error', undefined],
    ]);
  });

  it('also hides the earlier wording of the hand-off note in a stored history', () => {
    const parts = [
      { type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available', output: {
        success: true,
        message: 'Handed to the app. Whether it was carried out is not known: do not tell the user it succeeded, say it was requested. Do not quote this text.',
      } },
    ];
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail])).toEqual([['done', undefined]]);
  });
});
