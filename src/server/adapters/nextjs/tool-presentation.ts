/**
 * The wording the chat UI shows for the tools of a turn: a short label per
 * tool, keyed by the name the model calls it by, and the language of the app.
 * It comes from the pinned manifest (`presentation`, derived by
 * `glirastes tools refresh` or written with the tool descriptions), so a chat
 * without any `toolLabels` of its own never shows a raw tool name.
 */
export interface ToolPresentationPart {
  locale: string;
  tools: Record<string, { label: string }>;
}

interface WordedManifest {
  tools: ReadonlyArray<{
    name: string;
    modelName?: string;
    presentation?: { locale: string; approval: string };
  }>;
}

/** Null when the manifest words none of its tools. */
export function toolPresentationOf(manifest: WordedManifest | undefined): ToolPresentationPart | null {
  if (!manifest) return null;
  const tools: ToolPresentationPart['tools'] = {};
  let locale: string | undefined;
  for (const tool of manifest.tools) {
    if (!tool.presentation) continue;
    // The confirmation may be phrased as a question; the label is the action.
    const label = tool.presentation.approval.replace(/\s*\?+\s*$/, '').trim();
    if (label === '') continue;
    tools[tool.modelName ?? tool.name] = { label };
    locale ??= tool.presentation.locale;
  }
  return locale === undefined ? null : { locale, tools };
}
