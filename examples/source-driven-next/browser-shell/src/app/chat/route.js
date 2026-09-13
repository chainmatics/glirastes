import { createAiChatHandler } from 'glirastes/server/nextjs';
import { materializeManifestToolRegistry } from 'glirastes/runtime';
import { bindings, source } from '../../../.glirastes/runtime.mjs';
import { resolveSession } from '../../auth.js';
import { testModel } from '../../test-model.js';

export const runtime = 'nodejs';
export const POST = createAiChatHandler({
  managedRuntime: { resolvePrincipal: resolveSession, resolveTurnSnapshot: (context) => source.resolveTurnSnapshot(context) },
  loadTools: ({ turnSnapshot }) => materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings }),
  model: () => testModel(),
  systemPrompt: 'Use only the available native queries; ask when the target is unclear.',
  maxSteps: 3, maxOutputTokens: 200, emitStepReports: true,
});
