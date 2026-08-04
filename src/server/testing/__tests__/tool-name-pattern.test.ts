import { describe, expect, it } from 'vitest';
import { TOOL_NAME_PATTERN } from '../smoke.js';

describe('tool naming convention', () => {
  // The managed manifest names tools by definitionId (`ui.navigate`,
  // `tasks.bulkUpdateStatus`). The convention accepts both those and the
  // historical snake_case names; anything else stays rejected.
  it('accepts dotted definitionIds with camelCase segments', () => {
    for (const name of [
      'ui.navigate',
      'tasks.bulkUpdateStatus',
      'ui.taskView.switch',
      'suggest_followups',
      'list_tasks',
    ]) {
      expect(name, `${name} should be a valid tool name`)
        .toMatch(TOOL_NAME_PATTERN);
    }
  });

  it('rejects names outside the convention', () => {
    for (const name of [
      'Navigate',
      'ui..navigate',
      '.navigate',
      'navigate.',
      'ui navigate',
      'ui-navigate',
      '1tasks.list',
    ]) {
      expect(name, `${name} should be rejected`)
        .not.toMatch(TOOL_NAME_PATTERN);
    }
  });
});
