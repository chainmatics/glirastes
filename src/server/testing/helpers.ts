import type {
  ModuleDefinition,
  IntentClassification,
  Guardrails,
  AiRouter,
  GuardrailsConfig,
  ValidationResult,
} from '../../types.js';
import { createAiRouter } from '../core/index.js';
import type { SimulatedPipelineResult } from './types.js';

// ============================================================================
// Local guardrails for pipeline simulation (basic input validation only).
// Full guardrails with Lancer Warden delegation live in server-pro.
// ============================================================================

const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /tell\s+me\s+your\s+(system\s+)?prompt/i,
  /you\s+are\s+now\s+a\s+different/i,
  /act\s+as\s+an?\s+(admin|root|system)/i,
  /bypass\s+(security|auth)/i,
];

function createLocalGuardrails(config?: GuardrailsConfig): Guardrails {
  const maxLength = config?.maxInputLength ?? 4000;
  const injectionEnabled = config?.enableInjectionDetection ?? true;
  const patterns = [
    ...DEFAULT_INJECTION_PATTERNS,
    ...(config?.injectionPatterns ?? []),
  ];

  function validate(input: string): ValidationResult {
    const trimmed = input.trim();

    if (trimmed.length === 0) {
      return { valid: false, blocked: true, reason: 'empty_input', sanitized: '' };
    }

    if (trimmed.length > maxLength) {
      return {
        valid: false,
        blocked: true,
        reason: 'input_too_long',
        sanitized: trimmed.slice(0, maxLength),
      };
    }

    if (injectionEnabled) {
      for (const pattern of patterns) {
        if (pattern.test(trimmed)) {
          return {
            valid: true,
            blocked: false,
            reason: 'prompt_injection_signal',
            sanitized: trimmed,
          };
        }
      }
    }

    if (config?.customValidators) {
      for (const validator of config.customValidators) {
        const result = validator.validate(trimmed);
        if (!result.valid) return result;
      }
    }

    return { valid: true, blocked: false, sanitized: trimmed };
  }

  function sanitize(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length > maxLength) {
      return trimmed.slice(0, maxLength);
    }
    return trimmed;
  }

  return { validate, sanitize };
}

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
