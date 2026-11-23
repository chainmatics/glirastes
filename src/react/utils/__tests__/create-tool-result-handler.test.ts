import { describe, expect, it, vi } from 'vitest';
import { createToolResultHandler } from '../create-tool-result-handler.js';

describe('createToolResultHandler and the hand-off shape of UI tool results', () => {
  it('treats a handed-off UI tool result as successful, like success: true', () => {
    const onSuccess = vi.fn();
    const setFilters = vi.fn();
    const handle = createToolResultHandler({ onSuccess, actionHandlers: { 'set-filters': setFilters } });

    handle('ui_filter', { handedOff: true, message: 'Handed to the app.', uiAction: { type: 'set-filters', filters: {} } });
    handle('ui_filter', { success: true, message: 'Action executed.', uiAction: { type: 'set-filters', filters: {} } });
    handle('tasks_list', { success: false, error: 'nope' });

    expect(setFilters).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });
});
