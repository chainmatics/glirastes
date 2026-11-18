import { isLanguageTag, resolveTextTable } from '../../../contracts/localized-text.js';
import { DEFAULT_BUDGET_STOP_TEXTS, resolveBudgetStopTexts, type BudgetStopTexts } from './budget-stop-notice.js';
import { SILENT_TURN_FALLBACK_TEXTS } from './silent-turn-fallback.js';

/**
 * Every text the handler writes into a chat itself, by key: the budget stop
 * notice (`closing`, `closingWithoutAnswer`, one per reason) and the answer
 * of a turn that produced nothing (`silentTurn`). Model hints are not among
 * them: the model reads English only.
 */
export type ChatServerTexts = BudgetStopTexts & { silentTurn: string };

/** The app's texts per BCP-47 language tag; each table may hold any subset of keys. */
export type ChatServerLocales = Readonly<Record<string, Partial<ChatServerTexts>>>;

const BUILT_IN: Readonly<Record<string, ChatServerTexts>> = Object.freeze({
  en: Object.freeze({ ...DEFAULT_BUDGET_STOP_TEXTS.en, silentTurn: SILENT_TURN_FALLBACK_TEXTS.en }),
  de: Object.freeze({ ...DEFAULT_BUDGET_STOP_TEXTS.de, silentTurn: SILENT_TURN_FALLBACK_TEXTS.de }),
});

const KEYS: ReadonlySet<string> = new Set(Object.keys(BUILT_IN.en!));

/** Throws for a table under a tag that is no language tag, an unknown key or an empty text. */
export function assertChatServerLocales(locales: unknown, label = 'createAiChatHandler'): asserts locales is ChatServerLocales | undefined {
  if (locales === undefined) return;
  if (typeof locales !== 'object' || locales === null || Array.isArray(locales)) {
    throw new Error(`${label}: locales must be an object of text tables keyed by language tag`);
  }
  for (const [tag, table] of Object.entries(locales)) {
    if (!isLanguageTag(tag)) throw new Error(`${label}: locales.${tag} is not a BCP-47 language tag`);
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      throw new Error(`${label}: locales.${tag} must be an object of texts`);
    }
    for (const [key, value] of Object.entries(table)) {
      if (!KEYS.has(key)) throw new Error(`${label}: locales.${tag}.${key} is not a text key`);
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`${label}: locales.${tag}.${key} must be a non-empty string`);
      }
    }
  }
}

/**
 * The handler's texts for one turn's language. Per key: `budgetStopTexts`
 * (language-free, as before), then the app's `locales` and the built-in
 * German and English texts in the order of the language fallback (the
 * language, another region of it, English).
 */
export function resolveChatServerTexts(
  locale: string | undefined,
  budgetStopTexts: Partial<BudgetStopTexts> | undefined,
  locales: ChatServerLocales | undefined,
): ChatServerTexts {
  // Validates the language-free overrides exactly as before.
  if (budgetStopTexts !== undefined) resolveBudgetStopTexts(locale, budgetStopTexts);
  return Object.freeze(resolveTextTable<ChatServerTexts>({
    requested: locale,
    builtIn: BUILT_IN,
    ...(locales ? { app: locales } : {}),
    ...(budgetStopTexts ? { overrides: budgetStopTexts as Partial<ChatServerTexts> } : {}),
  }));
}
