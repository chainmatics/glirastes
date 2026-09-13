import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { type ObservedExecution } from './inventory-generation.js';
import { scanNextAppRoutes, type ScannedRouteCandidate } from './route-scanner.js';
import { FoundationExecutionInventorySchema } from './execution-inventory.js';

const ContractSchema = FoundationExecutionInventorySchema.shape.executions.element.options[0]
  .pick({ definitionId: true, inputSchemaDigest: true, outputSchemaDigest: true });

export interface ResolvedEndpointContract {
  definitionId: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
}

function fail(message: string, remediation: string): never {
  throw new FoundationDiagnosticError({
    code: 'E-INVENTORY-011', operation: 'generate.next-source', message, remediation,
  });
}

/**
 * Enumerate actual routes before resolving their local schema contracts. The
 * setup agent supplies a thin source-schema adapter, not a static tool list.
 * This stage does not grant exposure, infer authorization or upload sources.
 */
export async function collectNextEndpointExecutions(options: {
  rootDir: string;
  apiDir?: string;
  resolveContract: (candidate: ScannedRouteCandidate) => ResolvedEndpointContract | undefined
    | Promise<ResolvedEndpointContract | undefined>;
}): Promise<ObservedExecution[]> {
  let scan: Awaited<ReturnType<typeof scanNextAppRoutes>>;
  try {
    scan = await scanNextAppRoutes({ rootDir: options.rootDir, apiDir: options.apiDir, mode: 'source-discovery' });
  } catch {
    fail('Source discovery is incomplete; no updated inventory was produced.', 'complete-source-discovery');
  }
  if (scan.findings?.length) fail('Source discovery is incomplete; resolve source findings first.', 'complete-source-discovery');
  const observations: ObservedExecution[] = [];
  for (const candidate of scan.candidates) {
    let contract: ResolvedEndpointContract | undefined;
    try { contract = await options.resolveContract(structuredClone(candidate)); } catch {
      fail('A source contract could not be resolved. Ask the setup agent to assess it locally.', 'assess-source-contracts');
    }
    if (!contract) fail('A source contract is unresolved. Ask the setup agent to assess it locally.', 'assess-source-contracts');
    const parsed = ContractSchema.safeParse(contract);
    if (!parsed.success) fail('A source contract is invalid. Ask the setup agent to assess it locally.', 'assess-source-contracts');
    observations.push({
      ...parsed.data,
      executionKind: 'endpoint', stableKey: `${candidate.method} ${candidate.path}`,
      method: candidate.method, path: candidate.path,
      sourceFile: candidate.sourceFile, sourceFingerprint: candidate.sourceFingerprint,
    });
  }
  return observations;
}
