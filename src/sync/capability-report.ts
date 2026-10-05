import { AppSetupArtifactSchema, type AppSetupArtifact } from '../contracts/app-setup.js';
import { AppSetupClient } from './app-setup-client.js';

/** `sha256:` plus 43 base64url characters, the form the Platform registers (P08b Task 9). */
export const DISCOVERY_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

/**
 * What a runner tells the Platform about the code it runs (spec 4.10.6): the
 * committed, content-free setup artifact of that code. It describes tools and
 * never enables any.
 */
export interface CapabilityReport {
  artifact: AppSetupArtifact;
  discoveryDigest: string;
}

export interface CapabilityReportResult {
  discoveryDigest: string;
  runId: string;
  /** false: the Platform already held the artifact of this run. */
  uploaded: boolean;
}

export function capabilityReportFrom(setupArtifact: unknown): CapabilityReport {
  const artifact = AppSetupArtifactSchema.parse(setupArtifact);
  if (!DISCOVERY_DIGEST_PATTERN.test(artifact.discoveryDigest)) {
    throw new Error('The setup artifact discoveryDigest is not a sha256 digest');
  }
  return { artifact, discoveryDigest: artifact.discoveryDigest };
}

/**
 * Uploads the report through the app setup transport with the runner's
 * app-bound runtime key. Run identities are content-derived, so a repeated
 * upload of the same artifact names the same run; once the Platform holds its
 * artifact, nothing more is sent.
 */
export async function uploadCapabilityReport(options: {
  baseUrl: string;
  apiKey: string;
  appId: string;
  report: CapabilityReport;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CapabilityReportResult> {
  const { artifact } = options.report;
  if (artifact.appId !== options.appId) {
    throw new Error('Capability report targets a different app');
  }
  const client = new AppSetupClient({
    baseUrl: options.baseUrl,
    setupApiKey: options.apiKey,
    appId: options.appId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const run = await client.createRun({
    runId: artifact.runId,
    assessmentMode: artifact.assessmentMode,
    discoveryDigest: artifact.discoveryDigest,
  }, options.signal);
  const result = { discoveryDigest: artifact.discoveryDigest, runId: artifact.runId };
  if (run.artifactDigest) return { ...result, uploaded: false };
  await client.uploadArtifact(artifact, options.signal);
  return { ...result, uploaded: true };
}
