import { isLanguageTag, pickLanguage } from '../contracts/localized-text.js';
import type { ToolSearchSemantics, ToolSearchSemanticsMap } from './tool-discovery.js';

/** The labels of a tool in one language: one call, several calls, the approval. */
export interface ToolLabelTexts {
  readonly singular: string;
  readonly plural: string;
  readonly approval: string;
}

/** What people read about one tool, per BCP-47 language tag (`toolTexts` of the generated module). */
export interface ToolTexts {
  readonly labels?: Readonly<Record<string, ToolLabelTexts>>;
}

/** Keyed by the model-facing tool name, like `toolSearchSemantics`. Local only; never sent to the Platform. */
export type ToolTextsMap = Readonly<Record<string, ToolTexts>>;

/**
 * The labels of `texts` for `locale`: the requested tag, the same language
 * with another region, English, then the first tag. Undefined without labels.
 */
export function toolLabelsFor(texts: ToolTexts | undefined, locale: string | undefined): { language: string; labels: ToolLabelTexts } | undefined {
  const labels = texts?.labels;
  if (!labels) return undefined;
  const language = pickLanguage(Object.keys(labels).filter(isLanguageTag), locale);
  return language === undefined ? undefined : { language, labels: labels[language]! };
}

const MAX_SYNONYMS = 20;
const MAX_EXAMPLES = 10;

function union(first: ReadonlyArray<string> | undefined, second: ReadonlyArray<string> | undefined, max: number): string[] {
  return [...new Set([...first ?? [], ...second ?? []])].slice(0, max);
}

/**
 * The generated search semantics with the app's own added per tool: the
 * own synonyms and examples first, then the generated ones, each once and
 * within the limits of `find_tools`. Opt-in: `toolSemantics` of
 * `createAiChatHandler` still replaces the generated map when set alone.
 */
export function mergeToolSearchSemantics(
  generated: ToolSearchSemanticsMap | undefined,
  own: ToolSearchSemanticsMap | undefined,
): ToolSearchSemanticsMap {
  const merged: Record<string, ToolSearchSemantics> = { ...generated };
  for (const [name, entry] of Object.entries(own ?? {})) {
    const base = merged[name];
    const synonyms = union(entry.synonyms, base?.synonyms, MAX_SYNONYMS);
    const examples = union(entry.examples, base?.examples, MAX_EXAMPLES);
    merged[name] = {
      ...(synonyms.length > 0 ? { synonyms } : {}),
      ...(examples.length > 0 ? { examples } : {}),
    };
  }
  return merged;
}
