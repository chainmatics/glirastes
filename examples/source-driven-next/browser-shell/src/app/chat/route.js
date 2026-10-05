import { createAiChatHandler } from 'glirastes/server/nextjs';
import { createGeneratedRuntimeSource, materializeManifestToolRegistry } from 'glirastes/runtime';
import * as generated from '../../generated/glirastes/tools.generated.js';
import { resolveSession } from '../../auth.js';
import { testModel } from '../../test-model.js';

// Boots the standalone runtime from the committed outputs of `glirastes tools refresh`.
const glirastes = createGeneratedRuntimeSource(generated, {
  localLimits: {
    maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
    maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
    delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
  },
  identity: { tenantId: '019fb007-0000-7000-8000-000000000002' },
});

export const runtime = 'nodejs';
export const POST = createAiChatHandler({
  managedRuntime: { resolvePrincipal: resolveSession, resolveTurnSnapshot: (context) => glirastes.source.resolveTurnSnapshot(context) },
  loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: glirastes.bindings }),
  model: () => testModel(),
  systemPrompt: 'Use only the available native queries; ask when the target is unclear.',
  maxSteps: 3, maxOutputTokens: 200, emitStepReports: true,
});
