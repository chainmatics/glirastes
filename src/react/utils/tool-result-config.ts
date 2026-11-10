import type { ToolResultDisplayConfig, ToolResultDisplayMode } from '../types.js';

/**
 * The tool result display of a chat. Raw JSON under every answer is noise for
 * the people using an app, so without the app's own choice results are hidden
 * (the work log names what ran) unless the app registered renderers for them.
 */
export function resolveToolResultConfig(
  config: ToolResultDisplayConfig | undefined,
  hasRenderers: boolean,
): { mode: ToolResultDisplayMode; allowlist: string[] } {
  return {
    mode: config?.mode ?? (hasRenderers ? 'default' : 'hidden'),
    allowlist: config?.allowlist ?? [],
  };
}
