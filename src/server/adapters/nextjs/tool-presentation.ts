import { primaryLanguage } from '../../../contracts/localized-text.js';
import { toolLabelsFor, type ToolTextsMap } from '../../../runtime/tool-texts.js';

/**
 * The wording the chat UI shows for the tools of a turn: a short label per
 * tool, keyed by the name the model calls it by, and the language of the app.
 * It comes from the pinned manifest (`presentation`, derived by
 * `glirastes tools refresh` or written with the tool descriptions), so a chat
 * without any `toolLabels` of its own never shows a raw tool name. Only the
 * tools the turn's principal may use are named (`authorizedTurnToolIds`).
 */
export interface ToolPresentationPart {
  locale: string;
  tools: Record<string, { label: string }>;
}

interface WordedManifest {
  tools: ReadonlyArray<{
    toolId: string;
    name: string;
    modelName?: string;
    presentation?: { locale: string; approval: string };
  }>;
}

export interface ToolPresentationOptions {
  /** Labels per language (`toolTexts` of the generated module). Without them the part is the manifest's, unchanged. */
  texts?: ToolTextsMap;
  /** The language of this turn; absent: the manifest's part, unchanged, also with `texts`. */
  locale?: string;
}

// The confirmation may be phrased as a question; the label is the action.
const labelOf = (approval: string) => approval.replace(/\s*\?+\s*$/, '').trim();

/**
 * Null when the manifest words none of the tools in `allowedToolIds`, the
 * tool ids the turn's principal may use. With `texts`, each tool is worded
 * in the turn's language: the manifest's presentation where it is in that
 * language (a Platform revision may have curated it), else the generated
 * labels of the language or its fallback (English, then the first one).
 */
export function toolPresentationOf(
  manifest: WordedManifest | undefined,
  allowedToolIds: ReadonlySet<string>,
  options: ToolPresentationOptions = {},
): ToolPresentationPart | null {
  if (!manifest) return null;
  const allowed = manifest.tools.filter((tool) => allowedToolIds.has(tool.toolId));
  const texts = options.texts;
  // Only a stated turn language switches the wording; without one the manifest's part goes out as before.
  const localized = texts !== undefined && options.locale !== undefined
    && allowed.some((tool) => texts[tool.modelName ?? tool.name]?.labels !== undefined);
  if (!localized) {
    const tools: ToolPresentationPart['tools'] = {};
    let locale: string | undefined;
    for (const tool of allowed) {
      if (!tool.presentation) continue;
      const label = labelOf(tool.presentation.approval);
      if (label === '') continue;
      tools[tool.modelName ?? tool.name] = { label };
      locale ??= tool.presentation.locale;
    }
    return locale === undefined ? null : { locale, tools };
  }
  const locale = options.locale!;
  const tools: ToolPresentationPart['tools'] = {};
  for (const tool of allowed) {
    const name = tool.modelName ?? tool.name;
    const own = tool.presentation;
    const sameLanguage = own !== undefined && primaryLanguage(own.locale) === primaryLanguage(locale);
    const generated = sameLanguage ? undefined : toolLabelsFor(texts[name], locale);
    const approval = generated?.labels.approval ?? own?.approval;
    const label = approval === undefined ? '' : labelOf(approval);
    if (label === '' || label.length > 200) continue;
    tools[name] = { label };
  }
  return Object.keys(tools).length === 0 ? null : { locale, tools };
}
