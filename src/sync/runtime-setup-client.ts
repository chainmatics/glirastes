import type {
  ScannedRouteCandidate,
} from '../codegen/route-scanner.js';

export interface RouteScanUpload {
  schemaVersion: 1;
  generatedAt: string;
  candidates: ScannedRouteCandidate[];
  ignored: string[];
}

export interface RuntimeSetupImportResult {
  createdDrafts: number;
  unchanged: number;
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
    return response.json() as Promise<RuntimeSetupImportResult>;
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
}
