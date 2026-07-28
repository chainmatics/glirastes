import type {
  ScannedRouteCandidate,
} from '../codegen/route-scanner.js';
import { z } from 'zod';

export interface RouteScanUpload {
  schemaVersion: 1;
  generatedAt: string;
  candidates: ScannedRouteCandidate[];
  ignored: string[];
}

export interface RuntimeSetupImportResult {
  createdDrafts: number;
  unchanged: number;
  bindings: Array<{
    toolId: string;
    stableKey: string;
    sourceFingerprint: string;
  }>;
  tombstoneCandidates: Array<{
    toolId: string;
    stableKey: string;
  }>;
  interview: Array<{
    toolId: string;
    stableKey: string;
    reasonCodes: string[];
    questions: string[];
  }>;
}

const fingerprintSchema = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);
const toolIdentitySchema = z.object({
  toolId: z.string().uuid(),
  stableKey: z.string().trim().min(1).max(2_100),
}).strict();
const importResultSchema = z.object({
  createdDrafts: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  bindings: z.array(toolIdentitySchema.extend({
    sourceFingerprint: fingerprintSchema,
  }).strict()).max(5_000),
  tombstoneCandidates: z.array(toolIdentitySchema).max(5_000),
  interview: z.array(z.object({
    toolId: z.string().uuid(),
    stableKey: z.string().trim().min(1).max(2_100),
    reasonCodes: z.array(z.string().trim().min(1).max(200)).max(100),
    questions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  }).strict()).max(5_000),
}).strict();

export class RuntimeSetupClient {
  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    appId: string;
    environmentId: string;
    fetchImpl?: typeof fetch;
  }) {}

  async importRouteScan(
    scan: RouteScanUpload,
  ): Promise<RuntimeSetupImportResult> {
    const response = await (this.options.fetchImpl ?? fetch)(
      this.importUrl(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(this.sanitize(scan)),
      },
    );
    if (!response.ok) {
      throw new Error(`Glirastes setup import failed (${response.status})`);
    }
    const parsed = importResultSchema.safeParse(await response.json());
    if (!parsed.success || !this.matchesUpload(scan, parsed.data?.bindings)) {
      throw new Error('Invalid Glirastes setup import response');
    }
    return parsed.data;
  }

  private importUrl(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}`
      + `/v1/apps/${encodeURIComponent(this.options.appId)}`
      + `/environments/${encodeURIComponent(this.options.environmentId)}`
      + '/runtime-setup/scans';
  }

  private sanitize(scan: RouteScanUpload): RouteScanUpload {
    return {
      schemaVersion: 1,
      generatedAt: scan.generatedAt,
      candidates: scan.candidates.map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceFingerprint: candidate.sourceFingerprint,
        exportName: candidate.exportName,
        method: candidate.method,
        path: candidate.path,
        pathParams: [...candidate.pathParams],
        queryParams: candidate.queryParams.map((parameter) => ({
          name: parameter.name,
          repeated: parameter.repeated,
        })),
        schemaBindings: candidate.schemaBindings.map((binding) => ({
          symbol: binding.symbol,
          module: binding.module,
        })),
        authEvidence: [...candidate.authEvidence],
        externalCallEvidence: [...candidate.externalCallEvidence],
        riskClass: candidate.riskClass,
        autoApprovalEligible: false,
        reviewReasons: [...candidate.reviewReasons],
      })),
      ignored: [...scan.ignored],
    };
  }

  private matchesUpload(
    scan: RouteScanUpload,
    bindings: RuntimeSetupImportResult['bindings'] | undefined,
  ): boolean {
    if (!bindings || bindings.length !== scan.candidates.length) return false;
    const expected = new Map(scan.candidates.map((candidate) => [
      `${candidate.method} ${candidate.path}`,
      candidate.sourceFingerprint,
    ]));
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (
        seen.has(binding.stableKey)
        || expected.get(binding.stableKey) !== binding.sourceFingerprint
      ) {
        return false;
      }
      seen.add(binding.stableKey);
    }
    return seen.size === expected.size;
  }
}
