import { describe, expect, it } from 'vitest';
import { scopePipelineTools } from '../scope-pipeline-tools.js';

const aiTools = {
  ui_navigate: { name: 'ui_navigate' },
  tasks_list: { name: 'tasks_list' },
  suggest_followups: { name: 'suggest_followups' },
} as Record<string, unknown>;

const registryToolNames = new Set(Object.keys(aiTools));

describe('scopePipelineTools', () => {
  it('keeps an explicit empty selection empty', () => {
    expect(scopePipelineTools({
      aiTools, registryToolNames, selected: [], fallbackToAll: false,
    })).toEqual({});
  });

  it('does not expose unrelated tools when every selected tool was role-filtered', () => {
    expect(scopePipelineTools({
      aiTools: { ui_navigate: aiTools.ui_navigate },
      registryToolNames, selected: ['tasks_list'], fallbackToAll: false,
    })).toEqual({});
  });

  it('scopes to the selected tools', () => {
    const scoped = scopePipelineTools({
      aiTools,
      registryToolNames,
      selected: ['ui_navigate', 'suggest_followups'],
    });

    expect(Object.keys(scoped)).toEqual(['ui_navigate', 'suggest_followups']);
  });

  it('silently skips tools removed per principal (present in registry, absent from aiTools)', () => {
    const scoped = scopePipelineTools({
      aiTools: { suggest_followups: aiTools.suggest_followups },
      registryToolNames,
      selected: ['tasks_list', 'suggest_followups'],
    });

    expect(Object.keys(scoped)).toEqual(['suggest_followups']);
  });

  it('fails closed when the selection names tools the registry does not serve', () => {
    // A module referencing names the registry has never heard of is
    // configuration drift, not role filtering. Silently intersecting shipped
    // an app whose model could not call a single domain tool — this must be
    // loud and immediate instead.
    expect(() => scopePipelineTools({
      aiTools,
      registryToolNames,
      selected: ['navigate', 'list_tasks', 'suggest_followups'],
    })).toThrow(/unknown to the tool registry.*navigate.*list_tasks/s);
  });
});
