import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createLocalSchemaDigest } from 'glirastes/runtime';
import { uiToolToTool } from 'glirastes/server';

export async function collectNativeUi(root, previous) {
  let text;
  try { text = await readFile(resolve(root, 'src/ui-config.json'), 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT' || previous?.inventory.executions.some((entry) => entry.executionKind === 'ui')) {
      throw new Error('Native UI configuration missing or unreadable');
    }
    return [];
  }
  for (const file of ['src/ui-config.json', 'src/ui.js', 'src/glirastes-ui-bridge.js']) {
    if (await realpath(resolve(root, file)) !== resolve(root, file)) throw new Error('Native UI source must be app-local');
  }
  const nativeSource = await readFile(resolve(root, 'src/ui.js'), 'utf8');
  const bridgeSource = await readFile(resolve(root, 'src/glirastes-ui-bridge.js'), 'utf8');
  const { createUiContracts } = await import(pathToFileURL(resolve(root, 'src/ui.js')).href);
  const native = createUiContracts(JSON.parse(text));
  const outputSchema = z.object({ success: z.literal(true) });
  return [
    { kind: 'navigate', description: 'Navigate to an available app view.', inputSchema: native.navigationSchema,
      payload: { view: '$view' } },
    ...(native.filterSchema ? [{ kind: 'filter', description: 'Filter an available app view.', inputSchema: native.filterSchema,
      payload: { view: '$view', filters: '$filters' } }] : []),
  ].map(({ kind, description, inputSchema, payload }) => {
    const definitionId = `ui.${kind}`;
    const actionId = `native.${kind}`;
    const execution = { definitionId, stableKey: `UI ${kind}`, executionKind: 'ui', actionId,
      actionBindingRef: actionId,
      sourceFingerprint: `sha256:${createHash('sha256').update(JSON.stringify([kind, text, nativeSource, bridgeSource])).digest('base64url')}`,
      inputSchemaDigest: createLocalSchemaDigest(inputSchema), outputSchemaDigest: createLocalSchemaDigest(outputSchema) };
    return { execution, native: { inputSchema, outputSchema },
      tool: uiToolToTool({ id: definitionId, toolName: definitionId.replaceAll('.', '_'), description,
        inputSchema, outputSchema, needsApproval: false,
        uiAction: { type: 'native-ui', actionId, payload } }),
      candidate: { description, module: 'ui', sharedWith: [], usageHints: [description],
        presentation: { locale: 'en-US', singular: kind, plural: kind, approval: description },
        executionKind: 'ui', actionBindingRef: actionId, allowedRoles: ['member'], operationGroup: 'ui',
        riskClass: 'safe-read', enabled: true, requiresApproval: false },
    };
  });
}
