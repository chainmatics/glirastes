import type {
  Guardrails,
  GuardrailsConfig,
  ValidationResult,
} from '../../types.js';

const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /tell\s+me\s+your\s+(system\s+)?prompt/i,
  /you\s+are\s+now\s+a\s+different/i,
  /act\s+as\s+an?\s+(admin|root|system)/i,
  /bypass\s+(security|auth)/i,
];

/**
 * Deterministic, provider-independent input validation that runs entirely in
 * the target application. It never sends content to the control plane.
 */
export function createLocalGuardrails(
  config?: GuardrailsConfig,
): Guardrails {
  const maxLength = config?.maxInputLength ?? 4_000;
  const injectionEnabled = config?.enableInjectionDetection ?? true;
  const patterns = [
    ...DEFAULT_INJECTION_PATTERNS,
    ...(config?.injectionPatterns ?? []),
  ];

  function validate(input: string): ValidationResult {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return {
        valid: false,
        blocked: true,
        reason: 'empty_input',
        sanitized: '',
      };
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
        pattern.lastIndex = 0;
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

    for (const validator of config?.customValidators ?? []) {
      const result = validator.validate(trimmed);
      if (!result.valid) return result;
    }

    return {
      valid: true,
      blocked: false,
      sanitized: trimmed,
    };
  }

  return {
    validate,
    sanitize(input) {
      return input.trim().slice(0, maxLength);
    },
  };
}
