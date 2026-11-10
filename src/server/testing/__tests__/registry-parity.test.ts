import { describe, expect, it } from 'vitest';
import type { ModuleDefinition } from '../../../types.js';
import { assertModuleRegistryParity } from '../registry-parity.js';

const modules = [
  {
    id: 'navigation',
    name: 'Navigation',
    description: 'UI navigation',
    tools: ['ui_navigate', 'ui_taskView_switch'],
  },
  {
    id: 'task_query',
    name: 'Task Query',
    description: 'Query tasks',
    tools: ['tasks_list', 'suggest_followups'],
  },
] as ModuleDefinition[];

describe('assertModuleRegistryParity', () => {
  it('passes when every module tool resolves to a served name', () => {
    expect(() => assertModuleRegistryParity({
      modules,
      servedToolNames: ['ui.navigate', 'ui.taskView.switch', 'tasks.list'],
      extraToolNames: ['suggest_followups'],
    })).not.toThrow();
  });

  it('names every module tool the registry does not serve', () => {
    // Modules referencing retired names once shipped an app whose model
    // could not call a single domain tool. The check must name module and
    // offender so the drift is fixable from the failure alone.
    expect(() => assertModuleRegistryParity({
      modules,
      servedToolNames: ['ui.navigate'],
      extraToolNames: ['suggest_followups'],
    })).toThrow(/navigation.*ui_taskView_switch[\s\S]*task_query.*tasks_list/);
  });

  it('compares under the model-safe encoding of served names', () => {
    // Served names may be dotted definitionIds; module tools address their
    // encoded form. Both spellings of a served name are accepted.
    expect(() => assertModuleRegistryParity({
      modules: [{
        id: 'navigation',
        name: 'Navigation',
        description: 'UI navigation',
        tools: ['ui_navigate'],
      }] as ModuleDefinition[],
      servedToolNames: ['ui.navigate'],
    })).not.toThrow();
  });
});
