import type {
  EffectiveEnvironmentControl,
  EnvironmentControlBudgetCeiling,
  EnvironmentControlRateLimit,
} from '../contracts/index.js';

/**
 * Why a turn may not run: `assistant_halted` (a signed halt or a local
 * `control_unverifiable` halt), `control_unknown` (`controlFreshness:
 * 'required'` before the first successful sync).
 */
export type ManagedTurnHaltCode = 'assistant_halted' | 'control_unknown';

/** What the environment control lets a turn do right now. */
export type ManagedTurnControl =
  | {
      assistant: 'enabled';
      budgetCeiling?: EnvironmentControlBudgetCeiling;
      rateLimit?: EnvironmentControlRateLimit;
    }
  | { assistant: 'halted'; code: ManagedTurnHaltCode };

const HALT_MESSAGES: Record<ManagedTurnHaltCode, string> = {
  assistant_halted: 'The assistant is halted by its environment control',
  control_unknown: 'The environment control is not known yet; the assistant is halted',
};

/** Ends a turn at its next model step while the assistant is halted; content-free. */
export class AssistantHaltedError extends Error {
  constructor(readonly code: ManagedTurnHaltCode) {
    super(HALT_MESSAGES[code]);
    this.name = 'AssistantHaltedError';
  }
}

/** The turn control of the control in force; `known: false` halts unless a halt is known. */
export function turnControlOf(
  control: EffectiveEnvironmentControl | undefined,
  options: { known?: boolean } = {},
): ManagedTurnControl {
  if (control?.assistant === 'halted') return { assistant: 'halted', code: 'assistant_halted' };
  if (options.known === false) return { assistant: 'halted', code: 'control_unknown' };
  if (control?.kind !== 'environment-control') return { assistant: 'enabled' };
  return {
    assistant: 'enabled',
    ...(control.budgetCeiling ? { budgetCeiling: { ...control.budgetCeiling } } : {}),
    ...(control.rateLimit ? { rateLimit: { ...control.rateLimit } } : {}),
  };
}
