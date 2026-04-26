import type {
  ModuleDefinition,
  AiRouterConfig,
  AiRouter,
  SelectedTools,
  IntentClassification,
} from '../../types.js';

// ============================================================================
// Default Confidence Thresholds
// ============================================================================

const DEFAULT_THRESHOLDS = {
  high: 0.85,
  medium: 0.7,
} as const;

// ============================================================================
// Helpers
// ============================================================================

function getExpansionStrategy(
  confidence: number,
  thresholds: { high: number; medium: number },
): 'single' | 'expanded' | 'all' {
  if (confidence >= thresholds.high) return 'single';
  if (confidence >= thresholds.medium) return 'expanded';
  return 'all';
}

function getAllTools(modules: ModuleDefinition[]): string[] {
  const all = new Set<string>();
  for (const mod of modules) {
    for (const tool of mod.tools) all.add(tool);
    if (mod.sharedTools) {
      for (const tool of mod.sharedTools) all.add(tool);
    }
  }
  return [...all];
}

function unique(tools: string[]): string[] {
  return [...new Set(tools)];
}

// ============================================================================
// Module Definition Helper
// ============================================================================

/**
 * Define a module for intent-based tool routing.
 */
export function defineModule(config: ModuleDefinition): ModuleDefinition {
  return config;
}

// ============================================================================
// Router Factory
// ============================================================================

/**
 * Create an AI router that selects tools based on classified intent.
 *
 * The router uses confidence-based expansion:
 * - High confidence (>= 0.85): Only primary module's own tools
 * - Medium confidence (0.7-0.85): Primary module tools + shared tools from all modules
 * - Low confidence (< 0.7): All tools (ambiguous fallback)
 */
export function createAiRouter(config: AiRouterConfig): AiRouter {
  const {
    modules,
    relatedModules = {},
    confidenceThresholds = {},
  } = config;

  const thresholds = {
    high: confidenceThresholds.high ?? DEFAULT_THRESHOLDS.high,
    medium: confidenceThresholds.medium ?? DEFAULT_THRESHOLDS.medium,
  };

  const moduleMap = new Map(modules.map((m) => [m.id, m]));
  const allToolNames = getAllTools(modules);

  return {
    route(intent: IntentClassification, _allToolNames?: string[]): SelectedTools {
      // Ambiguous: use all tools
      if (intent.intent === 'ambiguous') {
        return {
          tools: unique(allToolNames),
          module: null,
          strategy: 'all',
        };
      }

      const primaryModule = moduleMap.get(intent.intent);
      if (!primaryModule) {
        return {
          tools: unique(allToolNames),
          module: null,
          strategy: 'all',
        };
      }

      const strategy = getExpansionStrategy(intent.confidence, thresholds);

      switch (strategy) {
        case 'single': {
          return {
            tools: unique([...primaryModule.tools]),
            module: primaryModule,
            strategy: 'single',
          };
        }

        case 'expanded': {
          const sharedFromAll = modules.flatMap((m) => m.sharedTools ?? []);
          return {
            tools: unique([...primaryModule.tools, ...sharedFromAll]),
            module: primaryModule,
            strategy: 'expanded',
          };
        }

        case 'all':
        default:
          return {
            tools: unique(allToolNames),
            module: null,
            strategy: 'all',
          };
      }
    },
  };
}
