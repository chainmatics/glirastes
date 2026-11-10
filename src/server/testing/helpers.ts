import type {
  ModuleDefinition,
  IntentClassification,
  Guardrails,
  AiRouter,
  GuardrailsConfig,
} from '../../types.js';
import {
  createAiRouter,
  createLocalGuardrails,
} from '../core/index.js';
import type { SimulatedPipelineResult } from './types.js';

// ============================================================================
// Internal Instance Cache
// ============================================================================

export interface PipelineComponents {
  guardrails: Guardrails;
  router: AiRouter;
  modules: ModuleDefinition[];
}

export function buildPipelineComponents(
  modules: ModuleDefinition[],
  guardrailsConfig?: GuardrailsConfig,
  confidenceThresholds?: { high?: number; medium?: number },
): PipelineComponents {
  const guardrails = createLocalGuardrails(guardrailsConfig);
  const router = createAiRouter({ modules, confidenceThresholds });
  return { guardrails, router, modules };
}

// ============================================================================
// Pipeline Simulation
// ============================================================================

export function simulatePipeline(
  components: PipelineComponents,
  input: string,
  intent: IntentClassification,
): SimulatedPipelineResult {
  const validation = components.guardrails.validate(input);

  if (validation.blocked) {
    return {
      blocked: true,
      tools: [],
      module: null,
      intent,
    };
  }

  const allTools = collectAllModuleTools(components.modules);
  const selected = components.router.route(intent, allTools);
  const tools = [...new Set([...selected.tools, 'suggest_followups'])];

  return {
    blocked: false,
    tools,
    module: selected.module?.id ?? null,
    intent,
    strategy: selected.strategy,
  };
}

// ============================================================================
// Utility: Collect all tools across modules
// ============================================================================

export function collectAllModuleTools(modules: ModuleDefinition[]): string[] {
  const all = new Set<string>();
  for (const mod of modules) {
    for (const tool of mod.tools) all.add(tool);
    if (mod.sharedTools) {
      for (const tool of mod.sharedTools) all.add(tool);
    }
  }
  return [...all];
}

export function getToolsByModule(modules: ModuleDefinition[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const mod of modules) {
    result[mod.id] = [...mod.tools, ...(mod.sharedTools ?? [])];
  }
  return result;
}
