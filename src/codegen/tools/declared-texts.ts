import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { isLanguageTag, MAX_TEXT_LANGUAGES, type LocalizedText } from '../../contracts/localized-text.js';
import { SEMANTICS_LIMITS } from './semantics.js';
import type { ToolProseHints } from './types.js';

/**
 * Texts an endpoint declares itself, in any language: OpenAPI
 * `x-glirastes-title`, `x-glirastes-description`, `x-glirastes-synonyms`,
 * `x-glirastes-examples`, and the same fields of a contract.ts entry
 * (`title`, `synonyms`, `examples`; `description` there may be per language
 * too). A text is one string (no language: used for all) or one per
 * BCP-47 tag. An invalid or secret-looking value is ignored whole and named
 * by its field, never by its content.
 */
export type DeclaredTextField = 'title' | 'description' | 'synonyms' | 'examples';

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !CONTROL.test(trimmed) ? trimmed : undefined;
}

/** One text, or one per language tag; `invalid` for anything else. */
export function readLocalizedText(value: unknown, max: number): LocalizedText | 'invalid' {
  if (typeof value === 'string') return text(value, max) ?? 'invalid';
  if (!isRecord(value)) return 'invalid';
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_TEXT_LANGUAGES) return 'invalid';
  const result: Record<string, string> = {};
  for (const [language, entry] of entries) {
    const checked = text(entry, max);
    if (!isLanguageTag(language) || checked === undefined) return 'invalid';
    result[language] = checked;
  }
  return result;
}

/** Lists per language tag (synonyms, examples); `invalid` for anything else. */
export function readPerLanguageLists(value: unknown, maxItems: number, maxLength: number): Record<string, string[]> | 'invalid' {
  if (!isRecord(value)) return 'invalid';
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_TEXT_LANGUAGES) return 'invalid';
  const result: Record<string, string[]> = {};
  for (const [language, list] of entries) {
    if (!isLanguageTag(language) || !Array.isArray(list) || list.length > maxItems) return 'invalid';
    const items = list.map((item) => text(item, maxLength));
    if (items.some((item) => item === undefined)) return 'invalid';
    result[language] = items as string[];
  }
  return result;
}

const READERS: Readonly<Record<DeclaredTextField, (value: unknown) => unknown>> = {
  title: (value) => readLocalizedText(value, SEMANTICS_LIMITS.title),
  description: (value) => readLocalizedText(value, SEMANTICS_LIMITS.description),
  synonyms: (value) => readPerLanguageLists(value, SEMANTICS_LIMITS.synonyms, SEMANTICS_LIMITS.synonym),
  examples: (value) => readPerLanguageLists(value, SEMANTICS_LIMITS.exampleCalls, SEMANTICS_LIMITS.example),
};

export interface DeclaredTexts {
  hints: Pick<ToolProseHints, 'title' | 'declaredDescription' | 'synonyms' | 'examples'>;
  /** Fields that were declared but are invalid or look like secrets, so they are ignored. */
  invalid: DeclaredTextField[];
}

/** Reads the declared texts of one endpoint; `values` holds the raw value per field (absent: not declared). */
export function readDeclaredTexts(values: Partial<Record<DeclaredTextField, unknown>>): DeclaredTexts {
  const hints: DeclaredTexts['hints'] = {};
  const invalid: DeclaredTextField[] = [];
  for (const field of ['title', 'description', 'synonyms', 'examples'] as const) {
    if (values[field] === undefined) continue;
    const read = READERS[field](values[field]);
    if (read === 'invalid' || findSensitiveStringPath(read)) {
      invalid.push(field);
      continue;
    }
    if (field === 'title') hints.title = read as LocalizedText;
    else if (field === 'description') hints.declaredDescription = read as LocalizedText;
    else hints[field] = read as Record<string, string[]>;
  }
  return { hints, invalid };
}
