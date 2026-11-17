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
});
