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

  it('reads a client-class answer of the backend as expected and everything else that failed as an error', () => {
    const out = (output: unknown) => ({ type: 'tool-tasks_call', toolCallId: `c${JSON.stringify(output)}`, state: 'output-available', output });
    const table: Array<[unknown, string, string | undefined]> = [
      // A backend answer with a 4xx status: a normal answer, even without classifyToolFailure.
      [{ success: false, error: 'Not found', status: 404, retryable: false, hint: 'Not found: …' }, 'expected', 'Not found'],
      [{ success: false, error: 'Forbidden', status: 403, retryable: false }, 'expected', 'Forbidden'],
      [{ success: false, error: 'Invalid', status: 400, retryable: false, bodyWithheld: 'withheld' }, 'expected', 'Invalid'],
      [{ success: false, error: 'Locked', status: 409 }, 'expected', 'Locked'],
      [{ success: false, error: 'Gone', status: 499 }, 'expected', 'Gone'],
      // Timeouts and rate limits are malfunctions.
      [{ success: false, error: 'Request Timeout', status: 408, retryable: true }, 'error', 'Request Timeout'],
      [{ success: false, error: 'Too Many Requests', status: 429, retryable: true }, 'error', 'Too Many Requests'],
      // 5xx and statuses outside 400–499.
      [{ success: false, error: 'Server error', status: 500, retryable: true }, 'error', 'Server error'],
      [{ success: false, error: 'Bad gateway', status: 502 }, 'error', 'Bad gateway'],
      [{ success: false, error: 'Odd', status: 399 }, 'error', 'Odd'],
      [{ success: false, error: 'Odd', status: 404.5 }, 'error', 'Odd'],
      [{ success: false, error: 'Odd', status: '404' }, 'error', 'Odd'],
      // The SDK's endpoint caller refused the call itself: it never reached the backend.
      [{ success: false, error: 'Endpoint path is not allowed', status: 403, retryable: false }, 'error', 'Endpoint path is not allowed'],
      [{ success: false, error: 'Endpoint path must be relative to the API', status: 400, retryable: false }, 'error', 'Endpoint path must be relative to the API'],
      // No status: a refused generated UI tool, a custom tool.
      [{ success: false, error: 'Not on this page.', retryable: false }, 'error', 'Not on this page.'],
      [{ success: false }, 'error', undefined],
      // A thrown tool error (timeout, network, response size) the server turned into an output.
      [{ error: 'Error in tasks.get: Endpoint timed out', hint: 'Check the parameters and try again.' }, 'error', 'Error in tasks.get: Endpoint timed out'],
      // The app's marker wins for any status.
      [{ success: false, error: 'Maintenance', status: 503, expectedFailure: true }, 'expected', 'Maintenance'],
      [{ success: false, error: 'Rate limited', status: 429, expectedFailure: true }, 'expected', 'Rate limited'],
      [{ success: false, error: 'Busy', expectedFailure: true }, 'expected', 'Busy'],
    ];
    const parts = table.map(([output]) => out(output));
    expect(readActivitySteps(parts, () => true).map((step) => [step.status, step.detail]))
      .toEqual(table.map(([, status, detail]) => [status, detail]));
    expect(readActivitySteps(parts, () => false).every((step) => step.detail === undefined)).toBe(true);
  });

  it('keeps other outputs done: success true, no success field, non-object outputs', () => {
    const parts = [
      { type: 'tool-a', toolCallId: 'c1', state: 'output-available', output: { success: true, message: 'Saved' } },
      { type: 'tool-b', toolCallId: 'c2', state: 'output-available', output: { items: [] } },
      { type: 'tool-c', toolCallId: 'c3', state: 'output-available', output: 'plain text' },
      { type: 'tool-d', toolCallId: 'c4', state: 'output-available', output: [{ success: false }] },
      { type: 'tool-e', toolCallId: 'c5', state: 'output-available', output: null },
      { type: 'tool-f', toolCallId: 'c6', state: 'output-available', output: { success: 'false' } },
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
