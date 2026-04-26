import type {
  ModelConfig,
  ModelSelectorConfig,
  ModelSelector,
  IntentClassification,
  ModuleDefinition,
  ToolContext,
} from '../../types.js';

// ============================================================================
// Flat-map Factory
// ============================================================================

/**
 * Create a model selector from a flat tier→modelId map.
 * The consuming app provides an `instanceFactory` that turns a modelId
 * string into a ready-to-use LanguageModel instance.
 */
export function createModelSelectorFromMap(
  models: Record<string, string>,
  instanceFactory: (modelId: string) => unknown,
  modules?: ModuleDefinition[],
): ModelSelector {
  const resolve = (tier: string) => models[tier] ?? models.standard ?? 'default';
  const tiers: ModelSelectorConfig = {
    fast:     { modelId: resolve('fast'), instance: instanceFactory(resolve('fast')) },
    standard: { modelId: resolve('standard'), instance: instanceFactory(resolve('standard')) },
    premium:  { modelId: resolve('powerful'), instance: instanceFactory(resolve('powerful')) },
  };
  return createModelSelector(tiers, modules);
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a model selector that picks the appropriate model based on
 * intent classification and module configuration.
 */
export function createModelSelector(
  tiers: ModelSelectorConfig,
  modules?: ModuleDefinition[],
): ModelSelector {
  const moduleMap = modules
    ? new Map(modules.map((m) => [m.id, m]))
    : new Map<string, ModuleDefinition>();

  return {
    select(
      intent: IntentClassification,
      _context?: ToolContext,
    ): ModelConfig {
      const module = moduleMap.get(intent.intent);
      const tier = module?.executionDefaults?.modelTier ?? 'standard';

      switch (tier) {
        case 'fast':
          return tiers.fast;
        case 'powerful':
          return tiers.premium;
        case 'standard':
        default:
          return tiers.standard;
      }
    },
  };
}
