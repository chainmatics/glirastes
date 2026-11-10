import type { ModuleDefinition } from '../../types.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';

/**
 * Assert that every tool a module references is actually served by the
 * execution registry / manifest. Modules referencing retired names once
 * shipped an app whose model could not call a single domain tool while every
 * fixture-based probe stayed green — this check must always run against the
 * real served names, never against a test fixture.
 *
 * `servedToolNames` accepts manifest names in either spelling: the signed
 * dotted definitionId (`ui.navigate`) or its model-safe encoding
 * (`ui_navigate`). `extraToolNames` covers locally added tools such as
 * `suggest_followups`.
 */
export function assertModuleRegistryParity(options: {
  modules: ReadonlyArray<ModuleDefinition>;
  servedToolNames: Iterable<string>;
  extraToolNames?: Iterable<string>;
}): void {
  const served = new Set<string>();
  for (const name of options.servedToolNames) {
    served.add(name);
    served.add(modelFacingToolName(name));
  }
  for (const name of options.extraToolNames ?? []) {
    served.add(name);
    served.add(modelFacingToolName(name));
  }

  const offenders: string[] = [];
  for (const module of options.modules) {
    for (const tool of module.tools) {
      if (!served.has(tool) && !served.has(modelFacingToolName(tool))) {
        offenders.push(`${module.id}: ${tool}`);
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      'Module tools unknown to the served registry '
      + '(module configuration drift):\n'
      + offenders.join('\n'),
    );
  }
}
