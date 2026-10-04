import type { ExecutionGenerationResult, ExecutionGenerationState } from 'glirastes/codegen';
import type { AppSetupArtifact, ExecutionBudget, Principal } from 'glirastes/contracts';
import type { LocalToolBinding, TurnSnapshot } from 'glirastes/runtime';

/** Type surface of the plain-JS reference adapter; consumed by the SDK tests only. */
export const tenantId: string;

export interface ReferenceTurn {
  snapshot: TurnSnapshot;
  execute(stableKey: string, input: unknown): Promise<unknown>;
}

export interface ReferenceGeneration extends ExecutionGenerationResult {
  bindings: LocalToolBinding[];
  artifact: AppSetupArtifact;
  limits: ExecutionBudget;
  createTurn(options: {
    request: Request;
    resolvePrincipal: () => Principal | undefined;
  }): ReferenceTurn;
}

export function generateReference(options: {
  rootDir: string;
  previous?: ExecutionGenerationState;
}): Promise<ReferenceGeneration>;
