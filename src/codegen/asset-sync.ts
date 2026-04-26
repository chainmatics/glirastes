export interface AssetSyncOptions {
  apiKey: string;
  glirasterUrl: string; // default: 'https://api.glirastes.chainmatics.io'
  name: string;
  type: 'skill' | 'mcp-server';
  version: string;
  toolCount: number;
  config: Record<string, unknown>;
  toolManifest: Record<string, unknown>;
  /** Pre-generated files to upload alongside the manifest */
  generatedFiles?: Array<{ path: string; content: string }>;
}

export interface AssetSyncResult {
  action: 'created' | 'updated';
  assetId: string;
}

export async function syncAssetToGlirastes(options: AssetSyncOptions): Promise<AssetSyncResult> {
  const url = `${options.glirasterUrl}/v1/registry/assets/sync`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify({
      name: options.name,
      type: options.type,
      version: options.version,
      toolCount: options.toolCount,
      config: options.config,
      toolManifest: options.toolManifest,
      generatedFiles: options.generatedFiles,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Glirastes sync failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { action: 'created' | 'updated'; asset: { id: string } };
  return { action: data.action, assetId: data.asset.id };
}
